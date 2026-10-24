import { RESPONSE_UNPARSEABLE, TRANSIENT_TRANSPORT_CODES } from "@bedrock-rbx/ocale";
import type { OpenCloudError, Result } from "@bedrock-rbx/ocale";
import type {
	LuauExecutionClient,
	LuauExecutionTask,
	LuauExecutionTaskRef,
} from "@bedrock-rbx/ocale/luau-execution";

import { FAILURE_LOG_TAIL, formatLogMessage } from "./poll-diagnosis.ts";

// Submit retries (client-options.ts) must omit RESPONSE_UNPARSEABLE: a resubmit
// can run the task twice.
const POLL_RETRYABLE_TRANSPORT_CODES = [...TRANSIENT_TRANSPORT_CODES, RESPONSE_UNPARSEABLE];

/** Read accepted tasks and terminal logs without creating more work. */
export class TaskReads {
	private readonly luau: LuauExecutionClient;

	/**
	 * Bind reads to the original SDK task client.
	 * @param luau - Client whose requests retain SDK pacing and retry policy.
	 */
	constructor(luau: LuauExecutionClient) {
		this.luau = luau;
	}

	/**
	 * Read the original task within the requested host observation budget.
	 * @param options - Task reference, deadline, observation signal and host allowance.
	 * @returns SDK terminal task or its preserved observation failure.
	 */
	public async pollAsync({
		deadlineMs,
		ref,
		signal,
		timeoutMs,
	}: {
		/**
		 * Absolute host deadline in Unix milliseconds.
		 */
		deadlineMs?: number;
		/**
		 * Original task reference.
		 */
		ref: LuauExecutionTaskRef;
		/**
		 * Abort observation and local waits without cancelling accepted tasks.
		 */
		signal?: AbortSignal | undefined;
		/**
		 * Host observation budget in milliseconds.
		 */
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
	 * Read newest terminal logs without replacing the original task failure.
	 * @param ref - Reference to the terminal task.
	 * @returns Newest-last log lines, already capped, or an empty array.
	 */
	public async readFailureLogTailAsync({
		ref,
		signal,
	}: {
		/**
		 * Original task reference; recovery never submits another task.
		 */
		ref: LuauExecutionTaskRef;
		/**
		 * Abort observation and local waits without cancelling accepted tasks.
		 */
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
}
