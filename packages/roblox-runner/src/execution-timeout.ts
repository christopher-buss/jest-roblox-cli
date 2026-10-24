import type { ScriptResult } from "./runner-types.ts";

/**
 * A timed-out observer can re-read its original task without submitting work.
 */
export class ExecutionTimeoutError extends Error {
	public readonly readResultAsync: (signal?: AbortSignal) => Promise<ScriptResult>;

	/**
	 * Retain the poll failure and same-task recovery handle.
	 * @param error - Poll failure whose message and `cause` are kept.
	 * @param readResultAsync - Observer that rereads the original accepted task.
	 */
	constructor(error: Error, readResultAsync: (signal?: AbortSignal) => Promise<ScriptResult>) {
		super(error.message, { cause: error.cause });
		this.readResultAsync = readResultAsync;
	}
}
