import type { ScriptResult } from "./types.ts";

/**
 * A timed-out observer can re-read its original task without submitting work.
 */
export class ExecutionTimeoutError extends Error {
	public readonly readResultAsync: (signal?: AbortSignal) => Promise<ScriptResult>;

	constructor(error: Error, readResultAsync: (signal?: AbortSignal) => Promise<ScriptResult>) {
		super(error.message, { cause: error.cause });
		this.readResultAsync = readResultAsync;
	}
}
