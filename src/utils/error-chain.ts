import { PermissionError } from "@bedrock-rbx/ocale";

export interface ChainEntry {
	readonly name: string;
	readonly code?: string | undefined;
	/**
	 * Response body an Open Cloud error captured, as one string. ocale caps it
	 * at 500 bytes, so this is a head rather than the whole body.
	 */
	readonly details?: string | undefined;
	readonly errno?: string | undefined;
	readonly message: string;
	/** HTTP method of the failing request, when the error names one. */
	readonly method?: string | undefined;
	readonly requiredScopes?: ReadonlyArray<string> | undefined;
	/**
	 * HTTP status from an Open Cloud `ApiError`, when the entry carries one.
	 */
	readonly statusCode?: number | undefined;
	readonly syscall?: string | undefined;
	/** URL of the failing request, when the error names one. */
	readonly url?: string | undefined;
}

const MAX_DEPTH = 5;

export function walkErrorChain(err: unknown): Array<ChainEntry> {
	const entries: Array<ChainEntry> = [];
	let current: unknown = err;
	while (current instanceof Error && entries.length < MAX_DEPTH) {
		entries.push({
			name: current.constructor.name,
			code: readStringProperty(current, "code"),
			details: readDetails(current),
			errno: readStringProperty(current, "errno"),
			message: current.message,
			method: readStringProperty(current, "method"),
			requiredScopes: current instanceof PermissionError ? current.requiredScopes : undefined,
			statusCode: readNumberProperty(current, "statusCode"),
			syscall: readStringProperty(current, "syscall"),
			url: readStringProperty(current, "url"),
		});
		current = current.cause;
	}

	return entries;
}

export function formatMissingScopes(scopes: ReadonlyArray<string>): string {
	if (scopes.length === 0) {
		return "API key has insufficient scopes. Add via Creator Dashboard.";
	}

	const joined = scopes.join(", ");
	return `API key missing scope${scopes.length === 1 ? "" : "s"} ${joined}. Add via Creator Dashboard.`;
}

/**
 * The `details` an ocale error carries. It is the parsed body when the server
 * sent JSON and the raw text when it did not, so both are rendered as a string
 * and the caller never has to know which one it got.
 */
function readDetails(err: Error): string | undefined {
	const value: unknown = Reflect.get(err, "details");
	if (value === undefined) {
		return undefined;
	}

	return typeof value === "string" ? value : JSON.stringify(value);
}

function readNumberProperty(err: Error, key: string): number | undefined {
	const value: unknown = Reflect.get(err, key);
	return typeof value === "number" ? value : undefined;
}

function readStringProperty(err: Error, key: string): string | undefined {
	const value: unknown = Reflect.get(err, key);

	if (typeof value === "string") {
		return value;
	}

	// Node errors carry `errno` as a number; anything else (object, boolean) has
	// no useful string form, so it reads as absent.
	if (typeof value === "number") {
		return String(value);
	}

	return undefined;
}
