import type { ScriptResult } from "@isentinel/roblox-runner";
import { ExecutionTimeoutError } from "@isentinel/roblox-runner";

import { EXECUTION_NOT_CLAIMED, EXECUTION_START_EXPIRED } from "../luau/execution-claim.ts";

/** Reads the result of a timed-out execution until `signal` aborts. */
export type ReadResult = (
	error: ExecutionTimeoutError,
	signal: AbortSignal,
) => Promise<ScriptResult>;

/** Settled state of one execution attempt. */
export type AttemptOutcome =
	| {
			/** Rejection reason of the attempt. */
			failure: unknown;
			/** Attempt rejected. */
			status: "rejected";
	  }
	| {
			/** Result of the attempt. */
			result: ScriptResult;
			/** Attempt fulfilled. */
			status: "fulfilled";
	  };

/** One running execution attempt and its settled outcome. */
export interface ObservedAttempt {
	/** Cancels the attempt. */
	cancel: () => void;
	/** Settles when the attempt settles; never rejects. */
	outcome: Promise<AttemptOutcome>;
}

/**
 * Rejects a result whose execution was already claimed or whose start window expired.
 * @param result - Script result to check.
 * @returns The same result.
 * @throws {Error} When the execution was already claimed or its start window expired.
 */
export function requireClaim(result: ScriptResult): ScriptResult {
	if (result.outputs[0] === EXECUTION_NOT_CLAIMED) {
		throw new Error("Test execution was already claimed; refusing to run tests twice.");
	}

	if (result.outputs[0] === EXECUTION_START_EXPIRED) {
		throw new Error(
			"Test execution's start window expired; check the client clock and Open Cloud queue delay.",
		);
	}

	return result;
}

/**
 * Reads the result of each timed-out failure and returns the first claimed one.
 * @param root0 - Recovery input.
 * @param root0.firstFailure - Failure of the original attempt.
 * @param root0.readResultAsync - Reads the result of a timed-out execution.
 * @param root0.replacementFailure - Failure of the replacement attempt.
 * @returns The first claimed result.
 * @rejects {AggregateError} When no reader returns a claimed result; its cause is `firstFailure`.
 */
export async function resolveRecoveryAsync({
	firstFailure,
	readResultAsync,
	replacementFailure,
}: {
	/** Failure of the original attempt. */
	firstFailure: unknown;
	/** Reads the result of a timed-out execution. */
	readResultAsync: ReadResult;
	/** Failure of the replacement attempt. */
	replacementFailure: unknown;
}): Promise<ScriptResult> {
	const failures = [firstFailure, replacementFailure];
	const observation = new AbortController();
	const readers = failures
		.filter((failure) => failure instanceof ExecutionTimeoutError)
		.map(async (failure) => {
			try {
				return requireClaim(await readResultAsync(failure, observation.signal));
			} catch (err) {
				failures.push(err);
				throw err;
			}
		});
	try {
		return await Promise.any(readers);
	} catch {
		// Each failed reader contributes its cause above.
	} finally {
		observation.abort();
	}

	// Recovery errors must retain the original uncertain execution as cause.
	throw new AggregateError(
		failures,
		`Open Cloud recovery failed: ${failures.map(String).join("\n")}`,
		{ cause: firstFailure },
	);
}

/**
 * Races the original and replacement attempts and returns the first claimed result, then recovers from failures.
 * @param root0 - Hedge input.
 * @param root0.original - Original attempt.
 * @param root0.readResultAsync - Reads the result of a timed-out execution.
 * @param root0.replacement - Replacement attempt; always cancelled on return.
 * @returns The first claimed result.
 * @rejects {AggregateError} When both attempts and recovery fail.
 */
export async function resolveHedgeAsync({
	original,
	readResultAsync,
	replacement,
}: {
	/** Original attempt. */
	readonly original: ObservedAttempt;
	/** Reads the result of a timed-out execution. */
	readonly readResultAsync: ReadResult;
	/** Replacement attempt; always cancelled on return. */
	readonly replacement: ObservedAttempt;
}): Promise<ScriptResult> {
	try {
		const taggedOriginal = original.outcome.then((outcome) => {
			return { attempt: "original" as const, outcome };
		});
		const taggedReplacement = replacement.outcome.then((outcome) => {
			return { attempt: "replacement" as const, outcome };
		});
		const first = await Promise.race([taggedOriginal, taggedReplacement]);
		const firstResult = claimedResult(first.outcome);
		if (firstResult !== undefined) {
			return firstResult;
		}

		const second = await (first.attempt === "original" ? taggedReplacement : taggedOriginal);
		const secondResult = claimedResult(second.outcome);
		if (secondResult !== undefined) {
			return secondResult;
		}

		const originalOutcome = first.attempt === "original" ? first.outcome : second.outcome;
		const replacementOutcome = first.attempt === "replacement" ? first.outcome : second.outcome;
		return await resolveRecoveryAsync({
			firstFailure: failureFrom(originalOutcome),
			readResultAsync,
			replacementFailure: failureFrom(replacementOutcome),
		});
	} finally {
		replacement.cancel();
	}
}

/**
 * Converts a result promise into an outcome that never rejects.
 * @param promise - Result promise to settle.
 * @returns The fulfilled or rejected outcome.
 */
export async function settleAsync(promise: Promise<ScriptResult>): Promise<AttemptOutcome> {
	try {
		return { result: await promise, status: "fulfilled" };
	} catch (err) {
		return { failure: err, status: "rejected" };
	}
}

function claimedResult(outcome: AttemptOutcome): ScriptResult | undefined {
	if (outcome.status === "rejected") {
		return undefined;
	}

	// Expiry refuses a late start; the other task can already own the claim.
	return outcome.result.outputs[0] === EXECUTION_NOT_CLAIMED ||
		outcome.result.outputs[0] === EXECUTION_START_EXPIRED
		? undefined
		: outcome.result;
}

function failureFrom(outcome: AttemptOutcome): unknown {
	if (outcome.status === "fulfilled") {
		try {
			return requireClaim(outcome.result);
		} catch (err) {
			return err;
		}
	}

	return outcome.failure;
}
