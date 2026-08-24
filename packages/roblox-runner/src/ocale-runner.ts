import type {
	HttpClient,
	OpenCloudClientOptions,
	OpenCloudError,
	Result,
	SleepFunc,
} from "@bedrock-rbx/ocale";
import {
	ApiError,
	NetworkError,
	PollTimeoutError,
	RESPONSE_UNPARSEABLE,
	TRANSIENT_TRANSPORT_CODES,
} from "@bedrock-rbx/ocale";
import type {
	FailedTask,
	LuauExecutionTask,
	LuauExecutionTaskRef,
	SubmitAtHeadParameters,
	SubmitAtVersionParameters,
} from "@bedrock-rbx/ocale/luau-execution";
import { LuauExecutionClient } from "@bedrock-rbx/ocale/luau-execution";
import type { PublishParameters } from "@bedrock-rbx/ocale/places";
import { PlacesClient } from "@bedrock-rbx/ocale/places";

import type buffer from "node:buffer";
import * as fs from "node:fs";
import * as path from "node:path";

import type {
	ExecuteScriptOptions,
	RemoteRunner,
	RunnerCredentials,
	ScriptResult,
	UploadPlaceOptions,
	UploadPlaceResult,
} from "./types.ts";

interface TaskParametersInput {
	readonly credentials: RunnerCredentials;
	readonly placeVersion: number | undefined;
	readonly script: string;
	readonly timeoutSeconds: number;
}

const MAX_TASK_TIMEOUT_SECONDS = 300;

/**
 * Wall clock the poll keeps beyond the server's own task deadline, so the
 * terminal `FAILED` the server writes is observable rather than raced.
 *
 * Roblox starts a task's `timeout` when the script begins running, not when
 * the task is created — a submit answers immediately and the place boot sits
 * between the two. Measured against a warm server the gap is 4-7s; a version
 * nobody has booted yet costs a cold boot, which
 * `open-cloud.ts` documents at 10-45s. A poll budget equal to the deadline
 * therefore expires while the task is still `PROCESSING`, every time, and the
 * authoritative `DEADLINE_EXCEEDED` (or the `SCRIPT_ERROR` the Luau VM writes
 * when it kills a non-yielding loop) is never read: the run reports
 * `PollTimeoutError` for a failure Roblox described.
 *
 * This is a cap, not a wait. A task that fails on time ends the poll the
 * moment it turns terminal, so the grace costs nothing on any run that gets
 * an answer — only a task Roblox never resolves spends it.
 */
const TASK_DEADLINE_GRACE_MS = 45_000;

/**
 * Task log messages carried on a failure, counted from the end. The tail is
 * what explains the failure; a full Jest run's output is megabytes and the
 * error banner is not where anyone reads it.
 */
const FAILURE_LOG_TAIL = 20;

/** Per-message cap on the failure log tail, in characters. */
const FAILURE_LOG_MESSAGE_LIMIT = 400;

/**
 * Statuses a place upload retries. Wider than ocale's upload default of `[429]`
 * alone, which guards against a 5xx that describes a write that partly landed.
 * A duplicate place version is not a hazard here: Roblox dedupes identical
 * place content, so a retry that races an upload which did land returns that
 * same version. Roblox's own 502 (`Request Context Failure`) is frequent enough
 * that surfacing it fails a test run for a fault that clears on the next
 * attempt.
 */
const UPLOAD_RETRYABLE_STATUSES = [429, 500, 502, 503, 504];

/**
 * Transport codes the task poll retries, wider than the submit's list by
 * `RESPONSE_UNPARSEABLE`. A poll carries the whole result envelope, so it is
 * the read the edge truncates, and re-reading it costs one GET against an
 * answer that already exists.
 *
 * The submit keeps the narrower list on purpose. Its 200 proves the task was
 * created, so a body too short to parse has still consumed a task slot: a
 * retry there would start a second execution nobody reads to recover a
 * response it lost. ocale leaves the code out of its create defaults for that
 * reason, and the two calls are issued separately here so each can say what it
 * means — `runUntilDone` would force one list onto both.
 */
const POLL_RETRYABLE_TRANSPORT_CODES = [...TRANSIENT_TRANSPORT_CODES, RESPONSE_UNPARSEABLE];

export interface OcaleRunnerOptions {
	baseUrl?: string | undefined;
	httpClient?: HttpClient;
	/**
	 * Max retry attempts the underlying Open Cloud client makes per request.
	 * Defaults to the client's own default (3). Raising it lets place uploads
	 * and task submits ride out a transient 429 throttle (the server's
	 * `retry-after` is honored) instead of surfacing the rate limit — useful
	 * when many runs share one place's per-minute upload quota.
	 */
	maxRetries?: number | undefined;
	readFile?: (filePath: string) => buffer.Buffer;
	sleep?: SleepFunc;
}

export class OcaleRunner implements RemoteRunner {
	private readonly credentials: RunnerCredentials;
	private readonly luau: LuauExecutionClient;
	private readonly places: PlacesClient;
	private readonly readFileFn: (filePath: string) => buffer.Buffer;

	constructor(credentials: RunnerCredentials, options?: OcaleRunnerOptions) {
		this.credentials = credentials;
		let clientOptions: OpenCloudClientOptions = { apiKey: credentials.apiKey };
		if (options?.baseUrl !== undefined) {
			clientOptions = { ...clientOptions, baseUrl: options.baseUrl };
		}

		if (options?.httpClient !== undefined) {
			clientOptions = { ...clientOptions, httpClient: options.httpClient };
		}

		if (options?.maxRetries !== undefined) {
			clientOptions = { ...clientOptions, maxRetries: options.maxRetries };
		}

		if (options?.sleep !== undefined) {
			clientOptions = { ...clientOptions, sleep: options.sleep };
		}

		this.luau = new LuauExecutionClient(clientOptions);
		this.places = new PlacesClient(clientOptions);
		this.readFileFn = options?.readFile ?? ((filePath) => fs.readFileSync(filePath));
	}

	public async executeScriptAsync({
		placeVersion,
		script,
		timeout,
	}: ExecuteScriptOptions): Promise<ScriptResult> {
		if (timeout <= 0) {
			throw new Error("Timeout must be a positive number");
		}

		const startTime = Date.now();
		const timeoutSeconds = Math.min(Math.floor(timeout / 1000), MAX_TASK_TIMEOUT_SECONDS);
		// Never below the caller's budget: a `timeout` past the server's
		// 300s ceiling already outlasts the deadline and needs no grace.
		const pollBudgetMs = Math.max(timeout, timeoutSeconds * 1000 + TASK_DEADLINE_GRACE_MS);

		const taskParameters = buildTaskParameters({
			credentials: this.credentials,
			placeVersion,
			script,
			timeoutSeconds,
		});
		const submitted = await this.luau.tasks.submit(taskParameters, {
			retryableTransportCodes: TRANSIENT_TRANSPORT_CODES,
			timeout,
		});
		if (!submitted.success) {
			throw toSubmitError(submitted.err);
		}

		// The poll clock starts here either way: `runUntilDone` also begins its
		// budget once the submit has returned.
		const result = await this.luau.tasks.pollUntilDone(submitted.data.ref, {
			retryableTransportCodes: POLL_RETRYABLE_TRANSPORT_CODES,
			timeoutMs: pollBudgetMs,
		});

		return this.toScriptResultAsync(result, {
			ref: submitted.data.ref,
			startTime,
			timeoutSeconds,
		});
	}

	public async uploadPlaceAsync(options: UploadPlaceOptions): Promise<UploadPlaceResult> {
		const placeFilePath = path.resolve(options.placeFilePath);
		const uploadStart = Date.now();
		const placeData = this.readFileFn(placeFilePath);

		const parameters: PublishParameters = {
			body: toArrayBufferView(placeData),
			format: deriveFormat(placeFilePath),
			placeId: this.credentials.placeId,
			universeId: this.credentials.universeId,
		};
		// Only the statuses are overridden. ocale's upload defaults already carry
		// every transient transport code plus `GATEWAY_REJECTED`, and a
		// per-request list replaces the default rather than extending it, so
		// naming the codes here would drop gateway-rejection retry.
		const requestOptions = { retryableStatuses: UPLOAD_RETRYABLE_STATUSES };
		const result =
			options.publish === true
				? await this.places.publish(parameters, requestOptions)
				: await this.places.save(parameters, requestOptions);
		if (!result.success) {
			throw new Error(
				`Failed to upload place ${placeFilePath}: ${describeUploadFailure(result.err)}`,
				{ cause: result.err },
			);
		}

		return {
			uploadMs: Date.now() - uploadStart,
			versionNumber: result.data.versionNumber,
		};
	}

	/**
	 * The tail of what the task printed, or nothing when Roblox will not say.
	 *
	 * Best-effort by construction: the logs are a second call made while the
	 * first one is already failing, so anything it returns is a bonus and
	 * anything it throws must not replace the failure being reported. The
	 * endpoint answers only once a task is terminal — polled mid-flight it
	 * returns an empty page — so this is a post-mortem read, not a stream.
	 *
	 * @param ref - Reference to the terminal task.
	 * @returns Newest-last log lines, already capped, or an empty array.
	 */
	private async readFailureLogTailAsync(ref: LuauExecutionTaskRef): Promise<Array<string>> {
		let page;
		try {
			page = await this.luau.tasks.listLogs({ ref });
		} catch {
			return [];
		}

		if (!page.success) {
			return [];
		}

		return page.data.messages.slice(-FAILURE_LOG_TAIL).map(formatLogMessage);
	}

	/**
	 * Turns a settled poll into outputs, or throws the failure it describes.
	 *
	 * Async because a `FAILED` task is worth one more call: Roblox's
	 * `error.message` names the category (`SCRIPT_ERROR`,
	 * `DEADLINE_EXCEEDED`) while the task logs carry what the script actually
	 * printed before it died, which is the part that identifies the fault.
	 *
	 * @param result - What `pollUntilDone` settled on.
	 * @param context - The task polled, run start, and the server's deadline.
	 * @returns The script's outputs when the task completed.
	 */
	private async toScriptResultAsync(
		result: Result<LuauExecutionTask, OpenCloudError>,
		context: { ref: LuauExecutionTaskRef; startTime: number; timeoutSeconds: number },
	): Promise<ScriptResult> {
		if (!result.success) {
			throw toPollError(result.err, context);
		}

		const task = result.data;
		if (task.state === "COMPLETE") {
			return {
				durationMs: Date.now() - context.startTime,
				outputs: task.output.results.map(coerceOutputToString),
			};
		}

		if (task.state === "FAILED") {
			const logTail = await this.readFailureLogTailAsync(task.ref);
			throw new Error(describeTaskFailure(task, logTail));
		}

		throw new Error(`Execution was cancelled (task ${task.ref.taskId})`);
	}
}

/**
 * Expands an upload failure into one diagnostic line. An `ApiError` carries
 * the failing call and how long it was in flight, and a bare `err.message`
 * throws all of that away: `HTTP 502: Request Context Failure` alone says
 * nothing about which request died, or whether it died on the wire or after
 * 30 seconds of upload.
 *
 * @param err - The Open Cloud error the upload returned.
 * @returns The error message, followed by the request context ocale captured.
 */
function describeUploadFailure(err: OpenCloudError): string {
	if (!(err instanceof ApiError) && !(err instanceof NetworkError)) {
		return err.message;
	}

	const target = err.url === undefined ? "" : ` on ${err.method} ${err.url}`;
	const elapsed =
		err instanceof ApiError && err.elapsedMs !== undefined
			? ` after ${(err.elapsedMs / 1000).toFixed(1)}s`
			: "";
	return `${err.message}${target}${elapsed}`;
}

function coerceOutputToString(value: JSONValue): string {
	if (typeof value === "string") {
		return value;
	}

	// Bedrock's wire-parsed output.results is JSONValue (no undefined, function,
	// or symbol entries), so JSON.stringify always returns a string here.
	return JSON.stringify(value);
}

/**
 * One log line, prefixed by the severity Roblox assigned it so an `ERROR`
 * stands out from the `print` above it, and truncated so one runaway line
 * cannot push the rest of the tail off the banner.
 *
 * @param message - A structured log message from the task's log page.
 * @returns The formatted, length-capped line.
 */
function formatLogMessage({
	message,
	messageType,
}: {
	message: string;
	messageType: string;
}): string {
	const body =
		message.length > FAILURE_LOG_MESSAGE_LIMIT
			? `${message.slice(0, FAILURE_LOG_MESSAGE_LIMIT)}…`
			: message;
	return `[${messageType}] ${body}`;
}

/**
 * The task's resource path, which is what the Open Cloud API and the Creator
 * Dashboard both key on. Built from the ref rather than kept as the raw
 * server string because ocale parses the path away on the way in.
 *
 * @param ref - The task reference carried on every task and every submit.
 * @returns The `universes/…/tasks/…` path, omitting segments Roblox left out.
 */
function describeTaskRef(ref: LuauExecutionTaskRef): string {
	// Both optional segments are present on any ref that got this far: ocale's
	// GET builder rejects a ref missing either, so a task that was polled at all
	// carries them — including one submitted against head, which Roblox answers
	// with the version it resolved.
	return (
		`universes/${ref.universeId}/places/${ref.placeId}` +
		`/versions/${String(ref.versionId)}` +
		`/luau-execution-sessions/${String(ref.sessionId)}/tasks/${ref.taskId}`
	);
}

/**
 * Names a terminal Roblox failure in full: the category code, Roblox's own
 * message, the task the run can be looked up by, and what the script printed
 * before it died.
 *
 * The code is not decoration. `DEADLINE_EXCEEDED` means the script outran its
 * budget and the log tail is where it was stuck; `SCRIPT_ERROR` means it threw
 * and the tail holds the traceback. Reporting `error.message` alone loses that
 * split, and loses the task id entirely.
 *
 * @param task - The `FAILED` task Roblox returned.
 * @param logTail - Formatted log lines, newest last; may be empty.
 * @returns The multi-line failure description.
 */
function describeTaskFailure(task: FailedTask, logTail: ReadonlyArray<string>): string {
	const lines = [
		`Roblox task failed (${task.error.code}): ${task.error.message}`,
		`  task: ${describeTaskRef(task.ref)}`,
	];
	if (logTail.length > 0) {
		lines.push("  Roblox output before the failure:");
		for (const line of logTail) {
			lines.push(`    ${line}`);
		}
	}

	return lines.join("\n");
}

/**
 * The state the last polled task was in, or `"unknown"`.
 *
 * `lastObservedTask` is `unknown` on the error type ocale hands back, and it is
 * absent entirely when the budget ran out before a single poll answered.
 * `Object()` flattens both into something readable, so one fallback covers a
 * missing task and an unrecognised one alike.
 *
 * @param task - The task the timeout error carried, if any.
 * @returns The task's state, or `"unknown"` when there is none to read.
 */
function readObservedState(task: unknown): string {
	const state: unknown = Reflect.get(Object(task), "state");
	return typeof state === "string" ? state : "unknown";
}

/**
 * Expands a poll that never settled into something actionable.
 *
 * Reaching here is itself the diagnosis, and the message says so. Roblox fails
 * a task that merely outran its deadline — `DEADLINE_EXCEEDED` lands a boot lag
 * after the deadline elapsed, which is what {@link TASK_DEADLINE_GRACE_MS}
 * waits for. A task still running past both has not overrun; it was never
 * scheduled, and the usual reason is a place version Roblox cannot load.
 * Measured against one, the task sat `PROCESSING` for ten minutes on a 30s
 * deadline and Roblox reported no state, no error, and no logs, ever — so
 * naming the suspicion here is the only diagnosis available.
 *
 * Everything else is passed through: an API response is already specific.
 *
 * @param err - The error the poll settled on.
 * @param context - The task polled and the deadline it was submitted with.
 * @returns The error to throw, carrying the ocale error as its cause.
 */
function toPollError(
	err: OpenCloudError,
	context: { ref: LuauExecutionTaskRef; timeoutSeconds: number },
): Error {
	if (!(err instanceof PollTimeoutError)) {
		return new Error(err.message, { cause: err });
	}

	const lines = [
		"Execution timed out: Roblox never reported a terminal state for the task " +
			`within ${String(Math.round(err.timeoutMs / 1000))}s ` +
			`(${String(context.timeoutSeconds)}s task deadline plus a ` +
			`${String(Math.round(TASK_DEADLINE_GRACE_MS / 1000))}s boot-lag allowance).`,
		`  task: ${describeTaskRef(context.ref)}`,
		`  last observed state: ${readObservedState(err.lastObservedTask)}`,
		"  A script that merely outran its deadline is failed by Roblox, so this " +
			"is most likely a place version Roblox could not start — such a task " +
			"is never scheduled and never reports anything. Open the place file " +
			"in Studio to see why it will not load.",
		"  The other reading is an unusually slow cold boot, which the next run " +
			"avoids by reusing the now-warm server.",
	];
	return new Error(lines.join("\n"), { cause: err });
}

/**
 * Names a submit that never created a task. Kept apart from the poll path
 * because a submit failure has no task to point at — there is nothing to look
 * up and nothing to log.
 *
 * @param err - The error the submit returned.
 * @returns The error to throw, carrying the ocale error as its cause.
 */
/**
 * The task a submit describes. `versionId` is present or the key is absent —
 * the parameters never carry it as `undefined`, which the client would send.
 */
function buildTaskParameters({
	credentials,
	placeVersion,
	script,
	timeoutSeconds,
}: TaskParametersInput): SubmitAtHeadParameters | SubmitAtVersionParameters {
	const base = {
		placeId: credentials.placeId,
		script,
		timeoutSeconds,
		universeId: credentials.universeId,
	};
	return placeVersion === undefined ? base : { ...base, versionId: String(placeVersion) };
}

function toSubmitError(err: OpenCloudError): Error {
	return new Error(err.message, { cause: err });
}

function toArrayBufferView(data: buffer.Buffer): Uint8Array<ArrayBuffer> {
	const view = new Uint8Array(data.byteLength);
	view.set(data);
	return view;
}

function deriveFormat(filePath: string): "rbxl" | "rbxlx" {
	return path.extname(filePath).toLowerCase() === ".rbxlx" ? "rbxlx" : "rbxl";
}
