import type { OpenCloudError, Result } from "@bedrock-rbx/ocale";
import { PollTimeoutError } from "@bedrock-rbx/ocale";
import type { LuauExecutionTask } from "@bedrock-rbx/ocale/luau-execution";

import type { PollContext } from "./poll-diagnosis.ts";
import { toPollError } from "./poll-diagnosis.ts";
import type { ScriptResult } from "./types.ts";

type TaskResult = Result<LuauExecutionTask, OpenCloudError>;

/**
 * A timed-out observer can re-read its original task without submitting work.
 */
export class ExecutionTimeoutError extends Error {
	public readonly readResultAsync: () => Promise<ScriptResult>;

	constructor(error: Error, readResultAsync: () => Promise<ScriptResult>) {
		super(error.message, { cause: error.cause });
		this.readResultAsync = readResultAsync;
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
	pollAsync: () => Promise<TaskResult>;
	resolveAsync: (result: TaskResult) => Promise<ScriptResult>;
}): Error {
	const described = toPollError(error, context);
	if (!(error instanceof PollTimeoutError)) {
		return described;
	}

	return new ExecutionTimeoutError(described, async () => resolveAsync(await pollAsync()));
}
