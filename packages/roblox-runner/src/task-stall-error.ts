import type { OpenCloudError } from "@bedrock-rbx/ocale";
import { PollTimeoutError } from "@bedrock-rbx/ocale";

import { ExecutionTimeoutError } from "./execution-timeout.ts";
import type { TaskStallEvidence } from "./infrastructure-evidence.ts";
import { collectStallEvidence } from "./infrastructure-evidence.ts";
import type { PollContext } from "./poll-diagnosis.ts";
import { toPollError } from "./poll-diagnosis.ts";
import type { ScriptResult } from "./runner-types.ts";

/**
 * A task that reached its deadline without a terminal state: a Roblox
 * infrastructure failure, not a Jest result.
 */
export class TaskStallError extends ExecutionTimeoutError {
	public readonly evidence: TaskStallEvidence;

	public override name = "TaskStallError";

	/**
	 * Retain an inconclusive task stall and its recovery handle.
	 * @param options - Original failure, recovery callback and inconclusive task evidence.
	 */
	constructor({
		error,
		evidence,
		readResultAsync,
	}: {
		error: Error;
		evidence: TaskStallEvidence;
		readResultAsync: (signal?: AbortSignal) => Promise<ScriptResult>;
	}) {
		super(error, readResultAsync);
		this.evidence = evidence;
	}
}

/**
 * Attach recovery to timeouts while retaining ordinary poll failures.
 * @param options - Original poll failure, observation context and same-task recovery callback.
 * @returns Recoverable timeout classification or the original poll failure.
 */
export function toExecutionError({
	context,
	error,
	readResultAsync,
}: {
	context: PollContext;
	error: OpenCloudError;
	readResultAsync: (signal?: AbortSignal) => Promise<ScriptResult>;
}): Error {
	const described = toPollError(error, context);
	if (!(error instanceof PollTimeoutError)) {
		return described;
	}

	return new TaskStallError({
		error: described,
		evidence: collectStallEvidence(context, error),
		readResultAsync,
	});
}
