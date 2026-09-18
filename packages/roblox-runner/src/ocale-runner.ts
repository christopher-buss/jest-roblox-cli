import type {
	HttpClient,
	OpenCloudClientOptions,
	OpenCloudError,
	Result,
	SleepFunc,
} from "@bedrock-rbx/ocale";
import {
	createFetchHttpClient,
	RateLimitError,
	RESPONSE_UNPARSEABLE,
	TRANSIENT_TRANSPORT_CODES,
} from "@bedrock-rbx/ocale";
import type {
	CompleteTask,
	LuauExecutionTask,
	LuauExecutionTaskRef,
	SubmitAtHeadParameters,
	SubmitAtVersionParameters,
} from "@bedrock-rbx/ocale/luau-execution";
import { LuauExecutionClient } from "@bedrock-rbx/ocale/luau-execution";
import type { PublishParameters } from "@bedrock-rbx/ocale/places";
import { PlacesClient } from "@bedrock-rbx/ocale/places";

import { AsyncLocalStorage } from "node:async_hooks";
import type buffer from "node:buffer";
import * as fs from "node:fs";
import * as path from "node:path";

import { createCapacitySubmitClient } from "./capacity-submit-client.ts";
import { toExecutionError } from "./execution-timeout.ts";
import type { PollContext } from "./poll-diagnosis.ts";
import {
	describeStatus,
	describeTaskFailure,
	describeUploadFailure,
	FAILURE_LOG_TAIL,
	formatLogMessage,
	resolveBudgets,
} from "./poll-diagnosis.ts";
import { TaskSubmitError } from "./task-submit-error.ts";
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

/* eslint-disable max-lines -- transport orchestration stays cohesive in the runner */

export interface SubmitDurationOptions {
	submitBudget?: number;
	submitCapacityBudget?: number;
}

export interface SubmitBudgetController {
	defer(milliseconds: number): void;
	pause(): (() => void) | undefined;
	progress(fingerprint: string): void;
	raceAsync<T>(submitting: Promise<T>): Promise<T>;
}

/** What a task submit settles on, success or failure, before it is read. */
type SubmitResult = Awaited<ReturnType<LuauExecutionClient["tasks"]["submit"]>>;

interface TaskObservation extends PollContext {
	observationSignal: AbortSignal | undefined;
	pollBudgetMs: number;
	startTime: number;
}

interface TaskParametersInput {
	readonly binaryInput: string | undefined;
	readonly credentials: RunnerCredentials;
	readonly placeVersion: number | undefined;
	readonly script: string;
	readonly timeoutSeconds: number;
}

/** Maximum wall time of an explicitly budgeted task submission. */
export function maximumSubmitDuration(
	options: SubmitDurationOptions & { submitBudget: number },
): number;
export function maximumSubmitDuration(options: SubmitDurationOptions): number | undefined;
export function maximumSubmitDuration(options: SubmitDurationOptions): number | undefined {
	return options.submitBudget === undefined
		? undefined
		: options.submitBudget + (options.submitCapacityBudget ?? 0);
}

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

const SAFE_SUBMIT_RETRY_STATUSES = [429, 500, 502, 503, 504];

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
	capacityWaitAsync?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
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
	private readonly capacityBudgetContext = new AsyncLocalStorage<SubmitBudgetController>();
	private readonly credentials: RunnerCredentials;
	private readonly fetchFn: typeof globalThis.fetch;
	private readonly luau: LuauExecutionClient;
	private readonly places: PlacesClient;
	private readonly readFileFn: (filePath: string) => buffer.Buffer;

	// eslint-disable-next-line flawless/max-lines-per-function -- transport clients share setup
	constructor(credentials: RunnerCredentials, options?: OcaleRunnerOptions) {
		this.credentials = credentials;
		const transport = options?.httpClient ?? createFetchHttpClient();
		const capacityAwareTransport =
			options?.maxRetries === 0
				? transport
				: createCapacitySubmitClient(transport, {
						onAdmissionWait: (milliseconds) => {
							this.capacityBudgetContext.getStore()?.defer(milliseconds);
						},
						onCapacityProgress: ({ fingerprint }) => {
							this.capacityBudgetContext.getStore()?.progress(fingerprint);
						},
						placeId: credentials.placeId,
						universeId: credentials.universeId,
						...(options?.capacityWaitAsync === undefined
							? {}
							: { waitAsync: options.capacityWaitAsync }),
					});
		let clientOptions: OpenCloudClientOptions = {
			apiKey: credentials.apiKey,
			hooks: {
				onAdmissionWait: () => this.capacityBudgetContext.getStore()?.pause(),
			},
			httpClient: capacityAwareTransport,
		};
		if (options?.baseUrl !== undefined) {
			clientOptions = { ...clientOptions, baseUrl: options.baseUrl };
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

	// eslint-disable-next-line flawless/max-lines-per-function -- validates and dispatches one task
	public async executeScriptAsync({
		binaryInput,
		bootProven = false,
		isSubmitIdempotent = false,
		observationSignal,
		onSubmitted,
		placeVersion,
		pollBudget,
		retrySubmitTransportErrors = true,
		script,
		submitBudget,
		submitCapacityBudget,
		timeout,
	}: ExecuteScriptOptions): Promise<ScriptResult> {
		if (timeout <= 0) {
			throw new Error("Timeout must be a positive number");
		}

		const startTime = Date.now();
		const budgets = resolveBudgets(timeout, pollBudget);

		const taskParameters = buildTaskParameters({
			binaryInput,
			credentials: this.credentials,
			placeVersion,
			script,
			timeoutSeconds: budgets.timeoutSeconds,
		});
		const submitted = await this.submitTaskAsync(taskParameters, {
			isSubmitIdempotent,
			retrySubmitTransportErrors,
			signal: observationSignal,
			submitBudget,
			submitCapacityBudget,
			timeout,
		});
		if (!submitted.success) {
			throw toSubmitError(submitted.err);
		}

		onSubmitted?.();
		return this.observeTaskAsync({
			...budgets,
			bootProven,
			observationSignal,
			ref: submitted.data.ref,
			startTime,
		});
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

	private async observeTaskAsync(context: TaskObservation): Promise<ScriptResult> {
		const result = await this.pollTaskAsync({
			ref: context.ref,
			signal: context.observationSignal,
			timeoutMs: context.pollBudgetMs,
		});
		return this.toScriptResultAsync(result, context);
	}

	private async pollTaskAsync({
		ref,
		signal,
		timeoutMs,
	}: {
		ref: LuauExecutionTaskRef;
		signal?: AbortSignal | undefined;
		timeoutMs: number;
	}): Promise<Result<LuauExecutionTask, OpenCloudError>> {
		return this.luau.tasks.pollUntilDone(ref, {
			retryableTransportCodes: POLL_RETRYABLE_TRANSPORT_CODES,
			...(signal === undefined ? {} : { signal }),
			timeoutMs,
		});
	}

	/**
	 * The tail of what the task printed, or nothing when Roblox will not say.
	 * Best-effort by construction: the logs are a second call made while the
	 * first one is already failing, so anything it returns is a bonus and
	 * anything it throws must not replace the failure being reported. The
	 * endpoint answers only once a task is terminal — polled mid-flight it
	 * returns an empty page — so this is a post-mortem read, not a stream.
	 *
	 * @param ref - Reference to the terminal task.
	 * @returns Newest-last log lines, already capped, or an empty array.
	 */
	private async readFailureLogTailAsync({
		ref,
		signal,
	}: {
		ref: LuauExecutionTaskRef;
		signal: AbortSignal | undefined;
	}): Promise<Array<string>> {
		let page;
		try {
			page = await this.luau.tasks.listLogs({ ref }, signal === undefined ? {} : { signal });
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
		{
			isSubmitIdempotent,
			retrySubmitTransportErrors,
			signal,
			submitBudget,
			submitCapacityBudget,
			timeout,
		}: {
			isSubmitIdempotent: boolean;
			retrySubmitTransportErrors: boolean;
			signal: AbortSignal | undefined;
			submitBudget: number | undefined;
			submitCapacityBudget: number | undefined;
			timeout: number;
		},
	): Promise<SubmitResult> {
		const budgetAbort = new AbortController();
		const submitSignal = combineSignals(signal, budgetAbort.signal);
		const submitOptions = {
			...(submitBudget === undefined ? {} : { maxRetries: BUDGETED_SUBMIT_MAX_RETRIES }),
			...(isSubmitIdempotent ? { retryableStatuses: SAFE_SUBMIT_RETRY_STATUSES } : {}),
			retryableTransportCodes: retrySubmitTransportErrors ? TRANSIENT_TRANSPORT_CODES : [],
			signal: submitSignal,
			timeout,
		};
		if (submitBudget === undefined) {
			return this.luau.tasks.submit(taskParameters, submitOptions);
		}

		const budget = createSubmitBudgetController({
			budgetMs: submitBudget,
			cancelSubmitting: () => {
				budgetAbort.abort("submit budget expired");
			},
			capacityBudgetMs: submitCapacityBudget ?? 0,
		});
		const submitting = this.capacityBudgetContext.run(budget, async () => {
			return this.luau.tasks.submit(taskParameters, submitOptions);
		});
		return budget.raceAsync(submitting);
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
		context: TaskObservation,
	): Promise<ScriptResult> {
		if (!result.success) {
			throw toExecutionError({
				context,
				error: result.err,
				pollAsync: async (signal) => {
					return this.pollTaskAsync({ ...recoveryPollOptions(context), signal });
				},
				resolveAsync: async (observed, signal) => {
					return this.toScriptResultAsync(observed, {
						...context,
						observationSignal: signal,
					});
				},
			});
		}

		const task = result.data;
		if (task.state === "COMPLETE") {
			return completedResult(task, context.startTime);
		}

		if (task.state === "FAILED") {
			const logTail = await this.readFailureLogTailAsync({
				ref: task.ref,
				signal: context.observationSignal,
			});
			throw new Error(describeTaskFailure(task, logTail));
		}

		throw new Error(`Execution was cancelled (task ${task.ref.taskId})`);
	}
}

/**
 * Bound local submission work. Aborting a request cannot undo a task Roblox
 * already accepted.
 */
// eslint-disable-next-line flawless/max-lines-per-function -- timer lifecycle is one state machine
export function createSubmitBudgetController({
	budgetMs,
	cancelSubmitting,
	capacityBudgetMs,
}: {
	budgetMs: number;
	cancelSubmitting: () => void;
	capacityBudgetMs: number;
}): SubmitBudgetController {
	const maximumMs = budgetMs + capacityBudgetMs;
	const startedAt = Date.now();
	let inactivityDeadline = startedAt + budgetMs;
	const expired = Promise.withResolvers<typeof SUBMIT_EXPIRED>();
	const progress = new Set<string>();
	let timer: ReturnType<typeof setTimeout>;
	let isSettled = false;
	let waiting = 0;
	let waitingSince = startedAt;

	function arm(): void {
		clearTimeout(timer);
		const remainingMaximum = maximumMs - (Date.now() - startedAt);
		timer = setTimeout(
			() => {
				expired.resolve(SUBMIT_EXPIRED);
			},
			waiting > 0
				? remainingMaximum
				: Math.min(inactivityDeadline - Date.now(), remainingMaximum),
		);
	}

	arm();
	return {
		defer(milliseconds) {
			if (isSettled || capacityBudgetMs === 0) {
				return;
			}

			// Validated admission waits consume the absolute allowance, not
			// inactivity.
			inactivityDeadline = Math.min(startedAt + maximumMs, inactivityDeadline + milliseconds);
			arm();
		},
		pause() {
			if (isSettled || capacityBudgetMs === 0) {
				return;
			}

			if (waiting === 0) {
				waitingSince = Date.now();
			}

			waiting += 1;
			arm();
			let hasResumed = false;
			return () => {
				if (hasResumed || isSettled) {
					return;
				}

				hasResumed = true;
				waiting -= 1;
				if (waiting === 0) {
					inactivityDeadline += Date.now() - waitingSince;
					arm();
				}
			};
		},
		progress(nextFingerprint) {
			if (isSettled || capacityBudgetMs === 0 || progress.has(nextFingerprint)) {
				return;
			}

			progress.add(nextFingerprint);
			inactivityDeadline = Date.now() + budgetMs;
			waitingSince = Date.now();
			arm();
		},
		async raceAsync<T>(submitting: Promise<T>): Promise<T> {
			try {
				const outcome: typeof SUBMIT_EXPIRED | { value: T } = await Promise.race([
					submitting.then((value) => ({ value })),
					expired.promise,
				]);
				if (outcome === SUBMIT_EXPIRED) {
					cancelSubmitting();
					if (capacityBudgetMs === 0) {
						throw new Error(
							`Open Cloud did not accept the task within ${describeSeconds(budgetMs)}. ` +
								"Open Cloud may be throttling creates, or the place may have no task slots available.",
						);
					}

					throw new Error(
						"Open Cloud did not accept the task " +
							`(${describeSeconds(budgetMs)} inactivity limit; ${describeSeconds(maximumMs)} maximum). ` +
							"Open Cloud may be throttling creates, " +
							"or the place may have no task slots available.",
					);
				}

				return outcome.value;
			} finally {
				isSettled = true;
				clearTimeout(timer);
			}
		},
	};
}

function describeSeconds(ms: number): string {
	return `${String(Math.round(ms / 1000))}s`;
}

function coerceOutputToString(value: JSONValue): string {
	if (typeof value === "string") {
		return value;
	}

	// Bedrock's wire-parsed output.results is JSONValue (no undefined, function,
	// or symbol entries), so JSON.stringify always returns a string here.
	return JSON.stringify(value);
}

function completedResult(task: CompleteTask, startTime: number): ScriptResult {
	return {
		durationMs: Date.now() - startTime,
		outputs: task.output.results.map(coerceOutputToString),
		terminalTask: {
			ref: { sessionId: task.ref.sessionId, taskId: task.ref.taskId },
			state: task.state,
		},
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

function combineSignals(first: AbortSignal | undefined, second: AbortSignal): AbortSignal {
	if (first === undefined) {
		return second;
	}

	return AbortSignal.any([first, second]);
}

function recoveryPollOptions(context: PollContext): {
	ref: LuauExecutionTaskRef;
	timeoutMs: number;
} {
	return { ref: context.ref, timeoutMs: context.recoveryPollBudgetMs };
}

function isServerErrorDetails(value: unknown): value is { code: string; message: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "code") === "string" &&
		typeof Reflect.get(value, "message") === "string"
	);
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
	if (err instanceof RateLimitError && isServerErrorDetails(err.details)) {
		return new TaskSubmitError(err, `${err.details.code}: ${err.details.message}`);
	}

	return new TaskSubmitError(err);
}

function toArrayBufferView(data: buffer.Buffer): Uint8Array<ArrayBuffer> {
	const view = new Uint8Array(data.byteLength);
	view.set(data);
	return view;
}

function deriveFormat(filePath: string): "rbxl" | "rbxlx" {
	return path.extname(filePath).toLowerCase() === ".rbxlx" ? "rbxlx" : "rbxl";
}

/* eslint-enable max-lines */
