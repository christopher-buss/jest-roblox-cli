export class ConfigError extends Error {
	public readonly hint: string | undefined;

	constructor(message: string, hint?: string) {
		super(message);
		this.hint = hint;
	}
}
