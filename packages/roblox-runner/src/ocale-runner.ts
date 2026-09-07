import type {
	HttpClient,
	OpenCloudClientOptions,
	OpenCloudError,
	Result,
	SleepFunc,
} from "@bedrock-rbx/ocale";
import { RESPONSE_UNPARSEABLE, TRANSIENT_TRANSPORT_CODES } from "@bedrock-rbx/ocale";
import type {
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
import { setTimeout as delay } from "node:timers/promises";

import type { PollContext } from "./poll-diagnosis.ts";
import {
	describeStatus,
	describeTaskFailure,
	describeUploadFailure,
	FAILURE_LOG_TAIL,
	formatLogMessage,
	TASK_DEADLINE_GRACE_MS,
	toPollError,
} from "./poll-diagnosis.ts";
import type {
	BinaryInputUploader,
	ExecuteScriptOptions,
	RemoteRunner,
	RunnerCredentials,
	ScriptResult,
	UploadBinaryInputOptions,
	UploadBinaryInputResult,
	UploadPlaceOptions,
	UploadPlaceResult,
} from "./types.ts";

/** What a task submit settles on, success or failure, before it is read. */
type SubmitResult = Awaited<ReturnType<LuauExecutionClient["tasks"]["submit"]>>;

interface TaskParametersInput {
	readonly binaryInput: string | undefined;
	readonly credentials: RunnerCredentials;
	readonly placeVersion: number | undefined;
	readonly script: string;
	readonly timeoutSeconds: number;
}

const MAX_TASK_TIMEOUT_SECONDS = 300;

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
 * Attempts a submit under an {@link ExecuteScriptOptions.submitBudget} is
 * allowed. High on purpose: the budget is the bound, and a count that bites
 * first would fail a submit the caller still had seconds to spend. Roblox's
 * `retry-after` on a metered create runs a few seconds, so this outlasts any
 * budget a caller would set.
 */
const BUDGETED_SUBMIT_MAX_RETRIES = 32;

/**
 * Race marker for a submit that outlived its
 * {@link ExecuteScriptOptions.submitBudget}.
 */
const SUBMIT_EXPIRED = "submit-budget-expired";

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
	/**
	 * The `fetch` a binary input's PUT goes over. The presigned upload URI is
	 * on a host the Open Cloud client does not own, so the client's transport
	 * cannot carry it; this is that call's own seam, defaulting to the global.
	 */
	fetch?: typeof globalThis.fetch;
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

export class OcaleRunner implements BinaryInputUploader, RemoteRunner {
	private readonly credentials: RunnerCredentials;
	private readonly fetchFn: typeof globalThis.fetch;
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
		this.fetchFn = options?.fetch ?? globalThis.fetch;
	}

	public async executeScriptAsync({
		binaryInput,
		bootProven = false,
		placeVersion,
		pollBudget,
		script,
		submitBudget,
		timeout,
	}: ExecuteScriptOptions): Promise<ScriptResult> {
		if (timeout <= 0) {
			throw new Error("Timeout must be a positive number");
		}

		const startTime = Date.now();
		const budgets = resolveBudgets(timeout, pollBudget);
		const { pollBudgetMs, timeoutSeconds } = budgets;

		const taskParameters = buildTaskParameters({
			binaryInput,
			credentials: this.credentials,
			placeVersion,
			script,
			timeoutSeconds,
		});
		const submitted = await this.submitTaskAsync(taskParameters, { submitBudget, timeout });
		if (!submitted.success) {
			throw toSubmitError(submitted.err);
		}

		const { ref } = submitted.data;
		// The poll clock starts here either way: `runUntilDone` also begins its
		// budget once the submit has returned.
		const result = await this.luau.tasks.pollUntilDone(ref, {
			retryableTransportCodes: POLL_RETRYABLE_TRANSPORT_CODES,
			timeoutMs: pollBudgetMs,
		});

		return this.toScriptResultAsync(result, { ...budgets, bootProven, ref, startTime });
	}

	/**
	 * Two calls: the client allocates a slot sized for the payload, then the
	 * bytes go straight to the presigned URI it returned. The allocation rides
	 * the client's pacer and retry, because `binaryInputs.create` is metered
	 * per key (five a minute) and a 429 there is the ordinary case for several
	 * runs sharing one key; the PUT is a plain upload to storage.
	 */
	public async uploadBinaryInputAsync({
		payload,
	}: UploadBinaryInputOptions): Promise<UploadBinaryInputResult> {
		const uploadStart = Date.now();
		const created = await this.luau.binaryInputs.create({
			size: payload.byteLength,
			universeId: this.credentials.universeId,
		});
		if (!created.success) {
			throw new Error(
				`Failed to allocate a binary input slot${describeStatus(created.err)}: ${created.err.message}`,
				{ cause: created.err },
			);
		}

		const response = await this.fetchFn(created.data.uploadUri, {
			body: payload,
			method: "PUT",
		});
		if (!response.ok) {
			throw new Error(
				`Failed to PUT the binary input (HTTP ${String(response.status)}): ${await response.text()}`,
			);
		}

		return { path: created.data.path, uploadMs: Date.now() - uploadStart };
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
	 * Create the task, and say how long the create may spend being refused.
	 *
	 * A `submitBudget` moves the limit on a rate-limited create from attempts
	 * to seconds. The two do not compose: an attempt count that bites first
	 * would end the wait early and at a point the caller never chose, so a
	 * budgeted submit is given a count high enough that the clock is what runs
	 * out. Unbudgeted, the client's own count is the only bound and the call
	 * takes as long as it takes.
	 *
	 * @param taskParameters - The task to create.
	 * @param budgets - The submit's wall clock, if any, and its request timeout.
	 * @returns The submit's result, unread.
	 */
	private async submitTaskAsync(
		taskParameters: SubmitAtHeadParameters | SubmitAtVersionParameters,
		{ submitBudget, timeout }: { submitBudget: number | undefined; timeout: number },
	): Promise<SubmitResult> {
		const submitting = this.luau.tasks.submit(taskParameters, {
			...(submitBudget === undefined ? {} : { maxRetries: BUDGETED_SUBMIT_MAX_RETRIES }),
			retryableTransportCodes: TRANSIENT_TRANSPORT_CODES,
			timeout,
		});
		return submitBudget === undefined
			? submitting
			: withSubmitBudgetAsync(submitting, submitBudget);
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
		context: PollContext & { startTime: number },
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

function coerceOutputToString(value: JSONValue): string {
	if (typeof value === "string") {
		return value;
	}

	// Bedrock's wire-parsed output.results is JSONValue (no undefined, function,
	// or symbol entries), so JSON.stringify always returns a string here.
	return JSON.stringify(value);
}

/**
 * The server-side deadline and the wall clock the poll is given.
 *
 * The default budget is never below the caller's `timeout`: one past the
 * server's 300s ceiling already outlasts the deadline and needs no grace.
 */
function resolveBudgets(
	timeout: number,
	pollBudget: number | undefined,
): { hasDefaultBudget: boolean; pollBudgetMs: number; timeoutSeconds: number } {
	const timeoutSeconds = Math.min(Math.floor(timeout / 1000), MAX_TASK_TIMEOUT_SECONDS);
	return {
		hasDefaultBudget: pollBudget === undefined,
		pollBudgetMs:
			pollBudget ?? Math.max(timeout, timeoutSeconds * 1000 + TASK_DEADLINE_GRACE_MS),
		timeoutSeconds,
	};
}

/**
 * The task a submit describes. `versionId` and `binaryInput` are each present
 * or the key is absent — the parameters never carry one as `undefined`, which
 * the client would send.
 */
function buildTaskParameters({
	binaryInput,
	credentials,
	placeVersion,
	script,
	timeoutSeconds,
}: TaskParametersInput): SubmitAtHeadParameters | SubmitAtVersionParameters {
	const base = {
		...(binaryInput === undefined ? {} : { binaryInput }),
		placeId: credentials.placeId,
		script,
		timeoutSeconds,
		universeId: credentials.universeId,
	};
	return placeVersion === undefined ? base : { ...base, versionId: String(placeVersion) };
}

function describeSeconds(ms: number): string {
	return `${String(Math.round(ms / 1000))}s`;
}

/**
 * Give the submit a deadline, and say what running past it means.
 *
 * A submit that has not answered in this long is not slow, it is waiting: the
 * only thing the client sleeps on is a `retry-after` from a metered create, and
 * the meter is on the key rather than on this run. So the remedy is about the
 * key, and the message says so — nothing the caller can do to its own request
 * moves a quota window someone else filled.
 *
 * The pending submit is left to settle unread. It is a create, so it may still
 * take a slot; the alternative is a caller that never returns, which is the
 * failure this exists to end.
 *
 * @param submitting - The in-flight submit, retries and all.
 * @param budgetMs - Wall clock the submit may spend before it is given up on.
 * @returns What the submit returned, when it returned in time.
 */
async function withSubmitBudgetAsync<T>(submitting: Promise<T>, budgetMs: number): Promise<T> {
	const abort = new AbortController();
	// The type argument is spelled out because inference widens the marker to
	// `string`, which the race's union would then swallow.
	const expiry = delay<typeof SUBMIT_EXPIRED>(budgetMs, SUBMIT_EXPIRED, {
		ref: false,
		signal: abort.signal,
	}).catch(
		// The `finally` abort is this promise's only rejection, and the race has
		// settled by the time it fires, so nothing reads what it resolves with.
		(): typeof SUBMIT_EXPIRED => SUBMIT_EXPIRED,
	);

	try {
		// The winner is boxed rather than compared by value: a submit result is
		// opaque here, so only a wrapper tells the two branches apart.
		const outcome: typeof SUBMIT_EXPIRED | { value: T } = await Promise.race([
			submitting.then((value) => ({ value })),
			expiry,
		]);
		if (outcome === SUBMIT_EXPIRED) {
			throw new Error(
				`Open Cloud did not accept the task within ${describeSeconds(budgetMs)}. ` +
					"Task creates are metered per API key, so a key several runs " +
					"share is refused on a window this run cannot shorten.\n" +
					"  Re-run when fewer runs share the key, or raise the budget if " +
					"this one is genuinely too tight.",
			);
		}

		return outcome.value;
	} finally {
		abort.abort();
	}
}

/**
 * Names a submit that never created a task. Kept apart from the poll path
 * because a submit failure has no task to point at — there is nothing to look
 * up and nothing to log.
 *
 * @param err - The error the submit returned.
 * @returns The error to throw, carrying the ocale error as its cause.
 */
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
