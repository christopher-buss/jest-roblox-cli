import { PermissionError, PollTimeoutError } from "@bedrock-rbx/ocale";

import { plural } from "../terminal/plural.ts";

/** One link of an error's cause chain, flattened for display. */
export interface ChainEntry {
	/** The error's constructor name. */
	readonly name: string;
	/** The Node error code, such as `ENOENT`. */
	readonly code?: string | undefined;
	/** Response body head an Open Cloud error captured. */
	readonly details?: string | undefined;
	/** The Node `errno`, as a string. */
	readonly errno?: string | undefined;
	/** The error message. */
	readonly message: string;
	/** HTTP method of the failing request, when the error names one. */
	readonly method?: string | undefined;
	/** The API key scopes a `PermissionError` says are missing. */
	readonly requiredScopes?: ReadonlyArray<string> | undefined;
	/** HTTP status from an Open Cloud `ApiError`. */
	readonly statusCode?: number | undefined;
	/** The system call a Node IO error names. */
	readonly syscall?: string | undefined;
	/** URL of the failing request, when the error names one. */
	readonly url?: string | undefined;
}

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
 * True when a poll that never settled is somewhere under this failure.
 * @param err - The failure to inspect.
 * @returns Whether anything in its cause chain is a `PollTimeoutError`.
 */
export function isPollTimeout(err: unknown): boolean {
	return errorChain(err).some((entry) => entry instanceof PollTimeoutError);
}

/**
 * Flatten an error and its causes, nearest first, for display.
 * @param err - The thrown value.
 * @returns One entry per `Error` in the chain, at most five.
 */
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

/**
 * Explain which API key scopes to add.
 * @param scopes - The missing scopes; empty when unknown.
 * @returns The message naming the scopes to add.
 */
export function formatMissingScopes(scopes: ReadonlyArray<string>): string {
	if (scopes.length === 0) {
		return "API key has insufficient scopes. Add via Creator Dashboard.";
	}

	const joined = scopes.join(", ");
	return `API key missing ${plural(scopes.length, "scope")} ${joined}. Add via Creator Dashboard.`;
}

function errorChain(err: unknown): Array<Error> {
	const chain: Array<Error> = [];
	let current = err;
	while (current instanceof Error && chain.length < MAX_DEPTH) {
		chain.push(current);
		current = current.cause;
	}

	return chain;
}

function readDetails(value: unknown): string | undefined {
	return typeof value === "string" ? value : JSON.stringify(value);
}

function readNumberDetail(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

function readStringDetail(value: unknown): string | undefined {
	if (typeof value === "string") {
		return value;
	}

	if (typeof value === "number") {
		return String(value);
	}

	return undefined;
}
