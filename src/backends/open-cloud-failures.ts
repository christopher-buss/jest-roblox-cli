import { PermissionError } from "@bedrock-rbx/ocale";

import { formatMissingScopes, walkErrorChain } from "../utils/error-chain.ts";

/**
 * A 404 makes the cached target suspect; it does not prove execution absent.
 *
 * @param err - The error to inspect.
 * @returns True when any error in the cause chain has status 404.
 */
export function isNotFoundError(err: unknown): boolean {
	return walkErrorChain(err).some((entry) => entry.statusCode === 404);
}

// Must match Open Cloud's error text for a return value over its 4 MiB cap.
const OVERSIZED_RESULT_PATTERN = /Return results too large/i;

/**
 * Rethrow an oversized-return failure with the remedy attached.
 *
 * @param err - The task failure.
 * @throws {@link Error} Always: `err` itself, or a new error with the remedy.
 */
export function rethrowOversizedResult(err: unknown): never {
	if (!(err instanceof Error) || !OVERSIZED_RESULT_PATTERN.test(err.message)) {
		throw err;
	}

	throw new Error(
		`${err.message}\n` +
			"One task returned more Jest output than Open Cloud accepts (4 MiB).\n" +
			"Coverage is usually the bulk of it. Try --no-coverage to confirm.\n" +
			"Only files in the coverage universe are probed, so narrowing " +
			"`collectCoverageFrom` to what you actually report on shrinks the " +
			"payload with it.\n" +
			'Otherwise set `parallel: "auto"` (or --parallel 2+) so results come ' +
			"back split across tasks, or narrow the run with --packages / --project.",
		{ cause: err },
	);
}

/**
 * Describe an error for a user message.
 *
 * @param err - The error to describe.
 * @returns The missing scopes for a permission cause, else the message.
 */
export function describeError(err: unknown): string {
	const cause = err instanceof Error ? err.cause : undefined;
	if (cause instanceof PermissionError) {
		return formatMissingScopes(cause.requiredScopes);
	}

	return err instanceof Error ? err.message : String(err);
}
