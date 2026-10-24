import type {
	HttpClient,
	OpenCloudClientOptions,
	RequestOptions,
	SleepFunc,
} from "@bedrock-rbx/ocale";
import type {
	LuauExecutionTask,
	SubmitAtHeadParameters,
	SubmitAtVersionParameters,
} from "@bedrock-rbx/ocale/luau-execution";
import { LuauExecutionClient } from "@bedrock-rbx/ocale/luau-execution";

import { AsyncLocalStorage } from "node:async_hooks";

import type { CapacitySubmitClientOptions } from "./capacity-submit-client.ts";
import { createCapacitySubmitClient } from "./capacity-submit-client.ts";
import { createSubmitRequestOptions } from "./client-options.ts";
import type { ExecuteScriptOptions, RunnerCredentials } from "./runner-types.ts";
import {
	combineSubmitSignals,
	createSubmitBudgetController,
	pauseBudgetWhileWaiting,
	waitForSubmitRetryAsync,
} from "./submit-budget.ts";
import type { SubmitBudgetController } from "./submit-budget.ts";
import { isEdgeRateLimited, refuseUnfitWait, toSubmitError } from "./submit-diagnosis.ts";
import { buildTaskParameters } from "./task-envelope.ts";

/** What a task submit settles on, success or failure, before it is read. */
type SubmitResult = Awaited<ReturnType<LuauExecutionClient["tasks"]["submit"]>>;

type TaskParameters = SubmitAtHeadParameters | SubmitAtVersionParameters;

interface TaskSubmissionOptions {
	capacityWaitAsync: CapacitySubmitClientOptions["waitAsync"];
	clientOptions: OpenCloudClientOptions & { httpClient: HttpClient };
	credentials: RunnerCredentials;
	luau: LuauExecutionClient;
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

/** Ocale's own per-request retry count, which an unbudgeted create mirrors. */
const DEFAULT_MAX_RETRIES = 3;

/** The least an edge-refused create waits before it is sent again. */
const EDGE_RETRY_FLOOR_MS = 1000;

/**
 * Creates one task per call under the caller's retry, budget and capacity
 * policy, and names a create that never produced a task.
 */
export class TaskSubmission {
	private readonly capacityBudgetContext = new AsyncLocalStorage<SubmitBudgetController>();
	private readonly capacityLuau: LuauExecutionClient;
	private readonly credentials: RunnerCredentials;
	private readonly luau: LuauExecutionClient;
	private readonly maxRetries: number;
	private readonly sleep: SleepFunc;

	/**
	 * Bind task creation to one place and the runner's SDK client.
	 * @param options - Capacity wait, SDK options, place identity and the
	 *   client an unbudgeted create shares with task reads.
	 */
	constructor({ capacityWaitAsync, clientOptions, credentials, luau }: TaskSubmissionOptions) {
		this.credentials = credentials;
		this.luau = luau;
		// Capacity admission serves budgeted submits only; an unbudgeted create
		// takes dmaas's answer as final.
		this.capacityLuau = new LuauExecutionClient({
			...clientOptions,
			httpClient: this.createCapacityTransport(clientOptions, capacityWaitAsync),
		});
		this.maxRetries = clientOptions.maxRetries ?? DEFAULT_MAX_RETRIES;
		this.sleep = clientOptions.sleep ?? waitForSubmitRetryAsync;
	}

	/**
	 * Create the task a script describes.
	 * @param options - Script, place version, binary input and submission policy.
	 * @param budgets - The task deadline as Unix milliseconds, and the server
	 *   timeout in seconds.
	 * @returns The accepted task, as the create answered it.
	 * @rejects A `TaskSubmitError` on create failure; a plain `Error` on budget expiry.
	 */
	public async submitAsync(
		{
			binaryInput,
			isSubmitIdempotent = false,
			observationSignal,
			placeVersion,
			retrySubmitTransportErrors = true,
			script,
			submitBudget,
			submitCapacityBudget,
			timeout,
		}: ExecuteScriptOptions,
		{ deadlineMs, timeoutSeconds }: { deadlineMs: number; timeoutSeconds: number },
	): Promise<LuauExecutionTask> {
		const taskParameters = buildTaskParameters({
			binaryInput,
			credentials: this.credentials,
			placeVersion,
			script,
			timeoutSeconds,
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
			throw toSubmitError(submitted.err, {
				apiKey: this.credentials.apiKey,
				placeVersion,
				timeoutSeconds,
			});
		}

		return submitted.data;
	}

	private createCapacityTransport(
		{ httpClient, maxRetries }: OpenCloudClientOptions & { httpClient: HttpClient },
		capacityWaitAsync: CapacitySubmitClientOptions["waitAsync"],
	): HttpClient {
		return maxRetries === 0
			? httpClient
			: createCapacitySubmitClient(httpClient, {
					onAdmissionWait: (milliseconds) => {
						this.capacityBudgetContext.getStore()?.defer(milliseconds);
					},
					onCapacityProgress: ({ fingerprint }) => {
						this.capacityBudgetContext.getStore()?.progress(fingerprint);
					},
					placeId: this.credentials.placeId,
					universeId: this.credentials.universeId,
					...(capacityWaitAsync === undefined ? {} : { waitAsync: capacityWaitAsync }),
				});
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
		taskParameters: TaskParameters,
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
		taskParameters: TaskParameters,
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
		const submitSignal = combineSubmitSignals(signal, budgetAbort.signal);
		const submitOptions = createSubmitRequestOptions({
			isSubmitIdempotent,
			retrySubmitTransportErrors,
			signal: submitSignal,
			submitBudget,
			timeout,
		});
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
}
