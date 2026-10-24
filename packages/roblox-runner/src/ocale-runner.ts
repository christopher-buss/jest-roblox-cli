import type { OpenCloudError, Result } from "@bedrock-rbx/ocale";
import { PollTimeoutError, RequestDeadlineExceededError } from "@bedrock-rbx/ocale";
import type { LuauExecutionTask } from "@bedrock-rbx/ocale/luau-execution";
import { LuauExecutionClient } from "@bedrock-rbx/ocale/luau-execution";
import { PlacesClient } from "@bedrock-rbx/ocale/places";

import type buffer from "node:buffer";

import type { PacedConnection } from "./client-options.ts";
import { createClientOptions } from "./client-options.ts";
import { CloudUploads } from "./cloud-uploads.ts";
import { readPlaceFile } from "./file-system.ts";
import type { PollContext } from "./poll-diagnosis.ts";
import { describeTaskFailure, resolveBudgets } from "./poll-diagnosis.ts";
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
} from "./runner-types.ts";
import { completedResult } from "./task-envelope.ts";
import { TaskReads } from "./task-reads.ts";
import { toExecutionError } from "./task-stall-error.ts";
import { TaskSubmission } from "./task-submission.ts";

/**
 * Injectable adapters and SDK request policy for one runner.
 */
export interface OcaleRunnerOptions extends Pick<
	PacedConnection,
	"baseUrl" | "httpClient" | "sleep"
> {
	/**
	 * Inject capacity polling separately from SDK retry sleep.
	 */
	capacityWaitAsync?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
	/**
	 * The `fetch` a binary input's PUT goes over. The presigned upload URI is
	 * on a host the Open Cloud client does not own, so the client's transport
	 * cannot carry it; this is that call's own seam, defaulting to the global.
	 */
	fetch?: typeof globalThis.fetch;
	/**
	 * Max retry attempts the underlying Open Cloud client makes per request.
	 * Defaults to the client's own default (3). Counts unguided 429s, 5xx and
	 * transport retries; a 429 with `retry-after` > 0 spends none.
	 */
	maxRetries?: number | undefined;
	/**
	 * Supply place bytes without accessing the host filesystem.
	 */
	readFile?: (filePath: string) => buffer.Buffer;
}

interface TaskObservation extends PollContext {
	/** When the poll gives up, as Unix epoch milliseconds. */
	deadlineMs: number;
	observationSignal: AbortSignal | undefined;
	startTime: number;
}

/**
 * Uploads places and observes remote tasks without duplicating accepted work.
 */
export class OcaleRunner implements BinaryInputUploader, RemoteRunner {
	private readonly reads: TaskReads;
	private readonly submission: TaskSubmission;
	private readonly uploads: CloudUploads;

	/**
	 * Bind SDK clients and upload adapters to one universe and place.
	 * @param credentials - Universe/place identity and authorized API key.
	 * @param options - Injectable request, upload and retry adapters.
	 */
	constructor(credentials: RunnerCredentials, options?: OcaleRunnerOptions) {
		const clientOptions = createClientOptions(credentials.apiKey, options);
		const luau = new LuauExecutionClient(clientOptions);

		this.reads = new TaskReads(luau);
		this.submission = new TaskSubmission({
			capacityWaitAsync: options?.capacityWaitAsync,
			clientOptions,
			credentials,
			luau,
		});
		this.uploads = new CloudUploads({
			credentials,
			fetch: options?.fetch ?? globalThis.fetch,
			luau,
			places: new PlacesClient(clientOptions),
			readFile: options?.readFile ?? readPlaceFile,
		});
	}

	/**
	 * Submit once and observe until a terminal result or host deadline.
	 * @param input - Script, task deadline, submission policy and observation signal.
	 * @returns Output values and total elapsed host time.
	 * @rejects When submission, execution or observation fails.
	 */
	public async executeScriptAsync(input: ExecuteScriptOptions): Promise<ScriptResult> {
		const options = { ...input };
		if (options.timeout <= 0) {
			throw new Error("Timeout must be a positive number");
		}

		const startTime = Date.now();
		const budgets = resolveBudgets(options.timeout, options.pollBudget);
		const deadlineMs = startTime + budgets.pollBudgetMs;

		const submitted = await this.submission.submitAsync(options, {
			deadlineMs,
			timeoutSeconds: budgets.timeoutSeconds,
		});
		options.onSubmitted?.();
		// A budgeted submit's poll starts its own clock.
		const pollDeadlineMs =
			options.submitBudget === undefined ? deadlineMs : Date.now() + budgets.pollBudgetMs;
		return this.observeTaskAsync({
			...budgets,
			bootProven: options.bootProven ?? false,
			deadlineMs: pollDeadlineMs,
			observationSignal: options.observationSignal,
			placeVersion: options.placeVersion,
			ref: submitted.ref,
			startTime,
			submittedState: submitted.state,
		});
	}

	/**
	 * Upload bytes through a presigned binary-input slot.
	 * @param options - Binary bytes to allocate and PUT.
	 * @returns Accepted resource path and elapsed upload time.
	 */
	public async uploadBinaryInputAsync(
		options: UploadBinaryInputOptions,
	): Promise<UploadBinaryInputResult> {
		return this.uploads.uploadBinaryInputAsync(options);
	}

	/**
	 * Save or publish place bytes through the configured SDK client.
	 * @param options - File path and save-or-publish selection.
	 * @returns Accepted place version and elapsed upload time.
	 */
	public async uploadPlaceAsync(options: UploadPlaceOptions): Promise<UploadPlaceResult> {
		return this.uploads.uploadPlaceAsync(options);
	}

	private async observeTaskAsync(context: TaskObservation): Promise<ScriptResult> {
		const result = await this.reads.pollAsync({
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

	private async recoverTaskAsync(
		context: TaskObservation,
		signal: AbortSignal | undefined,
	): Promise<ScriptResult> {
		const result = await this.reads.pollAsync({
			ref: context.ref,
			signal,
			timeoutMs: context.recoveryPollBudgetMs,
		});
		return this.toScriptResultAsync(result, {
			...context,
			observationSignal: signal,
			pollBudgetMs: context.recoveryPollBudgetMs,
		});
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
	 * @rejects When observation fails or the task ends without completing.
	 */
	private async toScriptResultAsync(
		result: Result<LuauExecutionTask, OpenCloudError>,
		context: TaskObservation,
	): Promise<ScriptResult> {
		if (!result.success) {
			throw toExecutionError({
				context,
				error: result.err,
				readResultAsync: async (signal) => this.recoverTaskAsync(context, signal),
			});
		}

		const task = result.data;
		if (task.state === "COMPLETE") {
			return completedResult(task, context.startTime);
		}

		if (task.state === "FAILED") {
			const logTail = await this.reads.readFailureLogTailAsync({
				ref: task.ref,
				signal: context.observationSignal,
			});
			throw new Error(describeTaskFailure(task, logTail));
		}

		throw new Error(`Execution was cancelled (task ${task.ref.taskId})`);
	}
}
