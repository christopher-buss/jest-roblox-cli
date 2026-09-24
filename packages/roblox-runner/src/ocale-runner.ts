import type {
	AdmissionWaitObserver,
	HttpClient,
	OpenCloudClientOptions,
	OpenCloudError,
	RequestOptions,
	Result,
	SleepFunc,
} from "@bedrock-rbx/ocale";
import {
	createFetchHttpClient,
	PollTimeoutError,
	RateLimitError,
	RequestDeadlineExceededError,
	RESPONSE_UNPARSEABLE,
	RetryDelayExceededError,
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

import { type } from "arktype";
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
	/** When the poll gives up, as Unix epoch milliseconds. */
	deadlineMs: number;
	observationSignal: AbortSignal | undefined;
	startTime: number;
}

interface SubmitTaskOptions {
	deadlineMs: number;
	isSubmitIdempotent: boolean;
	retrySubmitTransportErrors: boolean;
	signal: AbortSignal | undefined;
	submitBudget: number | undefined;
	submitCapacityBudget: number | undefined;
	timeout: number;
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

/** The body the edge rate limit answers with, when it sends one. */
const edgeRateLimitSchema = type({ errors: "unknown[]" });

/** ocale's own per-request retry count, which an unbudgeted create mirrors. */
const DEFAULT_MAX_RETRIES = 3;

/**
 * The longest `retry-after` of dmaas's per-minute limits. Longer is the
 * account's hourly create limit, whose `retry-after` names its unlock.
 */
const MINUTE_WINDOW_SECONDS = 60;

/**
 * The fraction of a second `toISOString` writes, which an unlock time drops.
 */
const ISO_MILLISECONDS = /\.\d{3}Z$/u;

/** The least an edge-refused create waits before it is sent again. */
const EDGE_RETRY_FLOOR_MS = 1000;

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
	private readonly capacityLuau: LuauExecutionClient;
	private readonly credentials: RunnerCredentials;
	private readonly fetchFn: typeof globalThis.fetch;
	private readonly luau: LuauExecutionClient;
	private readonly maxRetries: number;
	private readonly places: PlacesClient;
	private readonly readFileFn: (filePath: string) => buffer.Buffer;
	private readonly sleep: SleepFunc;

	// eslint-disable-next-line flawless/max-lines-per-function -- transport clients share setup
	constructor(credentials: RunnerCredentials, options?: OcaleRunnerOptions) {
		this.credentials = credentials;
		const transport = options?.httpClient ?? createFetchHttpClient();
		const capacityTransport =
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
			httpClient: transport,
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
		// Capacity admission serves budgeted submits only; an unbudgeted create
		// takes dmaas's answer as final.
		this.capacityLuau = new LuauExecutionClient({
			...clientOptions,
			httpClient: capacityTransport,
		});
		this.maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
		this.places = new PlacesClient(clientOptions);
		this.sleep = options?.sleep ?? delayAsync;
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
		const deadlineMs = startTime + budgets.pollBudgetMs;

		const taskParameters = buildTaskParameters({
			binaryInput,
			credentials: this.credentials,
			placeVersion,
			script,
			timeoutSeconds: budgets.timeoutSeconds,
		});
		const submitted = await this.submitTaskAsync(taskParameters, {
			deadlineMs,
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
		// A budgeted submit's poll starts its own clock.
		const pollDeadlineMs =
			submitBudget === undefined ? deadlineMs : Date.now() + budgets.pollBudgetMs;
		return this.observeTaskAsync({
			...budgets,
			bootProven,
			deadlineMs: pollDeadlineMs,
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

	/**
	 * Create one task. Only a refusal from the edge rate limit is sent again;
	 * anything dmaas answered is final.
	 *
	 * @param taskParameters - The task to create.
	 * @param submitOptions - The request options every attempt carries.
	 * @returns The create's result, unread.
	 */
	private async createTaskAsync(
		taskParameters: SubmitAtHeadParameters | SubmitAtVersionParameters,
		submitOptions: RequestOptions & { deadlineMs: number },
	): Promise<SubmitResult> {
		const options = { ...submitOptions, retryableStatuses: [] };
		let result = await this.luau.tasks.submit(taskParameters, options);
		for (let retry = 0; retry < this.maxRetries && isEdgeRateLimited(result); retry += 1) {
			const waitMs = Math.max(result.err.retryAfterSeconds * 1000, EDGE_RETRY_FLOOR_MS);
			const refusal = refuseUnfitWait({
				cause: result.err,
				deadlineMs: submitOptions.deadlineMs,
				waitMs,
			});
			if (refusal !== undefined) {
				return { err: refusal, success: false };
			}

			// An abort ends the wait; ocale then refuses the next attempt
			// locally.
			await this.sleep(waitMs, submitOptions.signal);
			result = await this.luau.tasks.submit(taskParameters, options);
		}

		return result;
	}

	private async observeTaskAsync(context: TaskObservation): Promise<ScriptResult> {
		const result = await this.pollTaskAsync({
			deadlineMs: context.deadlineMs,
			ref: context.ref,
			signal: context.observationSignal,
			timeoutMs: Math.max(0, context.deadlineMs - Date.now()),
		});
		// A read the deadline cut off is the same stall as a spent poll budget.
		if (!result.success && result.err instanceof RequestDeadlineExceededError) {
			const timedOut = new PollTimeoutError(result.err.message, {
				cause: result.err,
				timeoutMs: context.pollBudgetMs,
			});
			return this.toScriptResultAsync({ err: timedOut, success: false }, context);
		}

		return this.toScriptResultAsync(result, context);
	}

	private async pollTaskAsync({
		deadlineMs,
		ref,
		signal,
		timeoutMs,
	}: {
		deadlineMs?: number;
		ref: LuauExecutionTaskRef;
		signal?: AbortSignal | undefined;
		timeoutMs: number;
	}): Promise<Result<LuauExecutionTask, OpenCloudError>> {
		return this.luau.tasks.pollUntilDone(ref, {
			...(deadlineMs === undefined ? {} : { deadlineMs }),
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
	 * out. Unbudgeted, the task deadline bounds every wait.
	 *
	 * @param taskParameters - The task to create.
	 * @param budgets - The submit's wall clock or task deadline, and its
	 *   request timeout.
	 * @returns The submit's result, unread.
	 */
	private async submitTaskAsync(
		taskParameters: SubmitAtHeadParameters | SubmitAtVersionParameters,
		{
			deadlineMs,
			isSubmitIdempotent,
			retrySubmitTransportErrors,
			signal,
			submitBudget,
			submitCapacityBudget,
			timeout,
		}: SubmitTaskOptions,
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
			return isSubmitIdempotent
				? this.luau.tasks.submit(taskParameters, { ...submitOptions, deadlineMs })
				: this.createTaskAsync(taskParameters, { ...submitOptions, deadlineMs });
		}

		const budget = createSubmitBudgetController({
			budgetMs: submitBudget,
			cancelSubmitting: () => {
				budgetAbort.abort("submit budget expired");
			},
			capacityBudgetMs: submitCapacityBudget ?? 0,
		});
		const submitting = this.capacityBudgetContext.run(budget, async () => {
			return this.capacityLuau.tasks.submit(taskParameters, {
				...submitOptions,
				onAdmissionWait: pauseBudgetWhileWaiting(budget),
			});
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
						pollBudgetMs: context.recoveryPollBudgetMs,
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

/**
 * Holds the submit budget open while the SDK queues or honours a reported
 * budget. The SDK never nests one request's waits, so a single resume matches
 * each `started` to its `ended`. A `retry-delay` stays charged: it covers 5xx
 * backoff, and the 429 `retry-after` is credited through `defer` already.
 */
function pauseBudgetWhileWaiting(budget: SubmitBudgetController): AdmissionWaitObserver {
	let resume: (() => void) | undefined;
	return ({ phase, reason }) => {
		if (reason === "retry-delay") {
			return;
		}

		if (phase === "started") {
			resume = budget.pause();
			return;
		}

		resume?.();
		resume = undefined;
	};
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

function isEdgeRefusal(err: RateLimitError): boolean {
	return !(edgeRateLimitSchema(err.details) instanceof type.errors);
}

/**
 * A 429 from the edge rate limit, which never reached dmaas: only the edge
 * answers with a bare `errors` list.
 */
function isEdgeRateLimited(
	result: SubmitResult,
): result is Extract<SubmitResult, { success: false }> & { err: RateLimitError } {
	return !result.success && result.err instanceof RateLimitError && isEdgeRefusal(result.err);
}

/**
 * Refuse a retry wait that would end past the task deadline, naming the wait
 * and what is left of the deadline.
 */
function refuseUnfitWait({
	cause,
	deadlineMs,
	waitMs,
}: {
	cause: OpenCloudError;
	deadlineMs: number;
	waitMs: number;
}): RetryDelayExceededError | undefined {
	const remainingMs = Math.max(0, deadlineMs - Date.now());
	if (waitMs <= remainingMs) {
		return undefined;
	}

	return new RetryDelayExceededError(
		"Open Cloud asked the task create to wait before retrying, past the task deadline: " +
			`would wait ${describeSeconds(waitMs)}; ${describeSeconds(remainingMs)} remain`,
		{ cause, deadlineMs, remainingMs, retryAfterMs: waitMs },
	);
}

/** Wait `ms`, or less when `signal` aborts first. */
async function delayAsync(ms: number, signal?: AbortSignal): Promise<void> {
	await new Promise<void>((resolve) => {
		function finish(): void {
			clearTimeout(timer);
			signal?.removeEventListener("abort", finish);
			resolve();
		}

		const timer = setTimeout(finish, ms);
		signal?.addEventListener("abort", finish, { once: true });
	});
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
 * The unlock of the account's hourly create limit, when the 429 is one: a
 * dmaas refusal whose wait outlasts the per-minute window.
 */
function describeHourlyUnlock(err: RateLimitError): Array<string> {
	if (isEdgeRefusal(err) || err.retryAfterSeconds <= MINUTE_WINDOW_SECONDS) {
		return [];
	}

	const unlock = new Date(Date.now() + err.retryAfterSeconds * 1000);
	return [
		"  Roblox allows 30 task creates per hour per account; " +
			`this account can create tasks again at ${unlock.toISOString().replace(ISO_MILLISECONDS, "Z")}.`,
	];
}

/** The 429's evidence, one line each: the hourly unlock, code and headers. */
function describeRateLimit(err: RateLimitError): Array<string> {
	return [
		...describeHourlyUnlock(err),
		...(err.code === undefined ? [] : [`  code: ${err.code}`]),
		...Object.entries(err.responseHeaders ?? {}).map(([name, value]) => `  ${name}: ${value}`),
	];
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
	if (err instanceof RetryDelayExceededError && err.cause instanceof RateLimitError) {
		return new TaskSubmitError(err, [err.message, ...describeRateLimit(err.cause)].join("\n"));
	}

	if (!(err instanceof RateLimitError)) {
		return new TaskSubmitError(err);
	}

	const headline = isServerErrorDetails(err.details)
		? `${err.details.code}: ${err.details.message}`
		: err.message;
	return new TaskSubmitError(err, [headline, ...describeRateLimit(err)].join("\n"));
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
