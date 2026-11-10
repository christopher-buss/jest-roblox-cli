import type { RunnerErrorCode } from "../protocol/runner-error.ts";

const TASK_SCRIPT_PREFIX = /^TaskScript:\d+:\s*/;

/** A Luau-level script failure reported by the runner envelope. */
export class LuauScriptError extends Error {
	/** Jest's own stdout/stderr writes, narrower than `gameOutput`. */
	public bannerOutput: string | undefined;
	/**
	 * Whether the runner installed its output capture before the run failed.
	 */
	public captureInstalled: boolean | undefined;
	/** Stable code of the failure, when the runner sent one. */
	public code: RunnerErrorCode | undefined;
	/** The LogService.MessageOut dump of the failed run. */
	public gameOutput: string | undefined;
	/** The phase the runner reached before it failed. */
	public phase: string | undefined;
	/** Set when the run was abandoned at its `projectTimeout`. */
	public timedOut: boolean | undefined;

	/**
	 * Strip the `TaskScript:N:` prefix from the message.
	 *
	 * @param rawMessage - Error message as the runner reported it.
	 */
	constructor(rawMessage: string) {
		super(rawMessage.replace(TASK_SCRIPT_PREFIX, ""));
	}
}
