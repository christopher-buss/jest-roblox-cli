const TASK_SCRIPT_PREFIX = /^TaskScript:\d+:\s*/;

/** A Luau-level script failure reported by the runner envelope. */
export class LuauScriptError extends Error {
	/**
	 * Jest's own process.stdout/stderr writes captured via InterceptWriteable.
	 * Used by the CLI error banner to surface synchronous exit messages
	 * (e.g. "No tests found, exiting with code 1"). Narrower than
	 * `gameOutput`; see GLOSSARY.md for the split.
	 */
	public bannerOutput: string | undefined;
	/**
	 * Whether the runner installed its stdout/stderr interception before the
	 * run that failed. Set from the envelope's own `runner.captureInstalled`,
	 * and read by the exec-error report so "nothing was written" reads apart
	 * from "nobody was listening". Undefined when the runner does not say.
	 */
	public captureInstalled: boolean | undefined;
	/**
	 * The LogService.MessageOut dump for the failed run. Propagated through
	 * the exec-error path so `--gameOutput <path>` still receives the full
	 * log when an entry's envelope decodes to a Luau-level script failure.
	 */
	public gameOutput: string | undefined;
	/**
	 * How far into the entry the runner got before it failed, as the Luau side
	 * named the phase. Undefined when the runner names none.
	 */
	public phase: string | undefined;
	/**
	 * The run this failure came from was abandoned at its `projectTimeout`.
	 * Set from the envelope's own `runner.abandon` block, and read by the
	 * exec-error report so a timeout renders apart from a suite that threw.
	 */
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
