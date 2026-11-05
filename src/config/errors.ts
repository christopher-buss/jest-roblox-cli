/** A config problem reported to the user, with an optional fix hint. */
export class ConfigError extends Error {
	public readonly hint: string | undefined;

	/**
	 * Create the error.
	 *
	 * @param message - What is wrong with the config.
	 * @param hint - Optional advice on how to fix the config.
	 */
	constructor(message: string, hint?: string) {
		super(message);
		this.hint = hint;
	}
}
