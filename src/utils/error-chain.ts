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

/**
 * Diagnostic fields error sources hang off an `Error` instance: Node sets
 * `code`, `errno`, and `syscall` on IO failures, and ocale's `ApiError` sets
 * `statusCode`. `Error` declares none of them and their runtime types vary by
 * source — Node reports `errno` as a number, not a string — so each stays
 * `unknown` until a reader narrows it. Every `Error` satisfies the type, which
 * is what lets the chain walker read the fields without a cast.
 */
interface ErrorDetails extends Error {
	readonly code?: unknown;
	readonly details?: unknown;
	readonly errno?: unknown;
	readonly method?: unknown;
	readonly statusCode?: unknown;
	readonly syscall?: unknown;
	readonly url?: unknown;
}

const MAX_DEPTH = 5;

/**
 * The error and everything it was caused by, nearest first. Kept apart from
 * {@link walkErrorChain}, which renders each link for a human: a caller asking
 * "is there a `FooError` under this?" wants the instances, and `instanceof`
 * answers that where a class-name string only stands in for it.
 */
export function errorChain(err: unknown): Array<Error> {
	const chain: Array<Error> = [];
	let current = err;
	while (current instanceof Error && chain.length < MAX_DEPTH) {
		chain.push(current);
		current = current.cause;
	}

	return chain;
}

export function walkErrorChain(err: unknown): Array<ChainEntry> {
	const entries: Array<ChainEntry> = [];
	for (const current of errorChain(err)) {
		const details: ErrorDetails = current;
		entries.push({
			name: current.constructor.name,
			code: readStringDetail(details.code),
			details: readDetails(details.details),
			errno: readStringDetail(details.errno),
			message: current.message,
			method: readStringDetail(details.method),
			requiredScopes: current instanceof PermissionError ? current.requiredScopes : undefined,
			statusCode: readNumberDetail(details.statusCode),
			syscall: readStringDetail(details.syscall),
			url: readStringDetail(details.url),
		});
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
function readDetails(value: unknown): string | undefined {
	if (value === undefined) {
		return undefined;
	}

	return typeof value === "string" ? value : JSON.stringify(value);
}

function readNumberDetail(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

function readStringDetail(value: unknown): string | undefined {
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
