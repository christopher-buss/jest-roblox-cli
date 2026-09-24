import type { OpenCloudError, Result } from "@bedrock-rbx/ocale";
import { PollTimeoutError } from "@bedrock-rbx/ocale";
import type { LuauExecutionTask } from "@bedrock-rbx/ocale/luau-execution";

import { ExecutionTimeoutError } from "./execution-timeout.ts";
import type { TaskStallEvidence } from "./infrastructure-evidence.ts";
import { collectStallEvidence } from "./infrastructure-evidence.ts";
import type { PollContext } from "./poll-diagnosis.ts";
import { toPollError } from "./poll-diagnosis.ts";
import type { ScriptResult } from "./types.ts";

type TaskResult = Result<LuauExecutionTask, OpenCloudError>;

/**
 * A task that reached its deadline without a terminal state: a Roblox
 * infrastructure failure, not a Jest result.
 */
export class TaskStallError extends ExecutionTimeoutError {
	public readonly evidence: TaskStallEvidence;

	public override name = "TaskStallError";

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

export function toExecutionError({
	context,
	error,
	pollAsync,
	resolveAsync,
}: {
	context: PollContext;
	error: OpenCloudError;
	pollAsync: (signal: AbortSignal | undefined) => Promise<TaskResult>;
	resolveAsync: (result: TaskResult, signal: AbortSignal | undefined) => Promise<ScriptResult>;
}): Error {
	const described = toPollError(error, context);
	if (!(error instanceof PollTimeoutError)) {
		return described;
	}

	return new TaskStallError({
		error: described,
		evidence: collectStallEvidence(context, error),
		readResultAsync: async (signal) => resolveAsync(await pollAsync(signal), signal),
	});
}
