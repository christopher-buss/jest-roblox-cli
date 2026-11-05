import { PermissionError } from "@bedrock-rbx/ocale";

import { ConfigError } from "../config/errors.ts";
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

/**
 * Fail on a bundle that never reached Roblox, naming the cause and the way out.
 *
 * `binaryInputs.create` is metered per key — five a minute, and the owner of a
 * key may be running several agents on it — so the client has already retried
 * by the time this fires. Past that the run cannot ship its code at all, and
 * the transport's own message names neither what was being sent nor the flag
 * that stops sending it.
 *
 * @param err - The upload failure.
 * @throws {@link ConfigError} Always.
 */
export function rethrowBinaryInputFailure(err: unknown): never {
	throw new ConfigError(
		`The run's code could not be sent to Open Cloud as a binary input: ${describeError(err)}`,
		"`binaryInputs.create` is metered at five a minute per API key, and the " +
			"client has already retried inside that budget — so several runs " +
			"sharing one key is the usual cause.\n" +
			"Upload the code inside the place instead.",
	);
}

// Open Cloud's wording when a task's return value exceeds its 4 MiB cap. It
// rejects the whole task, so every package that task ran is lost with it.
const OVERSIZED_RESULT_PATTERN = /Return results too large/i;

/**
 * Rethrow an oversized-return failure with the remedy attached.
 *
 * Work-stealing already keeps a task under the cap by leaving queue items for
 * the next task, so reaching here means the split cannot help: either the run
 * is on the single-task path, or one package's own results exceed the cap.
 * Both need a decision from the user, and Open Cloud's bare message names
 * neither the cause nor a way out.
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
			"Coverage is usually the bulk of it — try --no-coverage to confirm.\n" +
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
