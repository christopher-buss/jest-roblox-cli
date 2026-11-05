import type { ScriptResult } from "@isentinel/roblox-runner";
import { ExecutionTimeoutError } from "@isentinel/roblox-runner";

import { randomUUID } from "node:crypto";
import process from "node:process";

import claimSource from "../../luau/execution-claim.luau";
import {
	EXECUTION_NOT_CLAIMED,
	EXECUTION_START_EXPIRED,
	type ExecutionClaimObservation,
} from "../luau/execution-claim.ts";
import { isPollTimeout } from "../utils/error-chain.ts";
import { createBootWatch, type SubmissionLifecycle } from "./execution-boot-watch.ts";
import {
	type AttemptOutcome,
	type ObservedAttempt,
	type ReadResult,
	requireClaim,
	resolveHedgeAsync,
	resolveRecoveryAsync,
	settleAsync,
} from "./execution-hedge.ts";

/**
 * The create may have succeeded; its relay remains observable without a task
 * ref.
 */
export class UncertainSubmissionError extends ExecutionTimeoutError {}

/** Milliseconds a task has to claim execution before a hedge starts. */
export const DEFAULT_BOOT_WATCH_MS = 45_000;

/** What one execution attempt receives. */
interface ExecutionAttemptContext {
	/** Luau source of the execution claim the task must take. */
	claim: string;
	/** Aborts when the attempt is no longer observed. */
	observationSignal: AbortSignal;
	/** Lifecycle hooks of the task submission. */
	submission: SubmissionLifecycle;
}

type ExecuteAttempt = (context: ExecutionAttemptContext) => Promise<ScriptResult>;

/**
 * A stalled observer gets one hedge and an ambiguous create gets one rescue;
 * every submission shares the claim that admits only one execution.
 *
 * @param options - Attempt runner, timeout, and the clock, key, and claim
 *   reader to use.
 * @returns The result of the one execution the claim admitted.
 * @rejects The first non-timeout failure, or the recovery failure when every
 *   attempt fails.
 */
// eslint-disable-next-line flawless/max-lines-per-function -- outcome routing stays with its race
export async function executeWithRecoveryAsync({
	bootWatchMs = DEFAULT_BOOT_WATCH_MS,
	createKey = randomUUID,
	executeAsync: executeAttemptAsync,
	now = Date.now,
	readClaimAsync,
	startupWindowMs,
	timeout,
	watchesSubmission = false,
}: {
	bootWatchMs?: number;
	createKey?: () => string;
	executeAsync: ExecuteAttempt;
	now?: () => number;
	readClaimAsync?: (key: string, signal: AbortSignal) => Promise<ExecutionClaimObservation>;
	startupWindowMs?: number;
	timeout: number;
	watchesSubmission?: boolean;
}): Promise<ScriptResult> {
	// Admit both attempts, including their poll grace and submission overhead.
	const windowMs = startupWindowMs ?? 2 * timeout + 180_000;
	const key = createKey();
	const claim = claimSource.replace("__EXECUTION_CLAIM_PARAMETERS__", () => {
		// Keep a minute of retention beyond the last permitted start.
		return `${JSON.stringify(key)}, ${String(now() + windowMs)}, ${String(Math.ceil(windowMs / 1000) + 60)}, ${JSON.stringify(EXECUTION_NOT_CLAIMED)}, ${JSON.stringify(EXECUTION_START_EXPIRED)}`;
	});
	const watch = createBootWatch({
		key,
		bootWatchMs,
		readClaimAsync,
		watchesSubmission,
	});
	const { executeAsync, readResultAsync } = withSubmissionRescue(executeAttemptAsync, {
		claim,
		submission: watch.submission,
	});
	const original = createObservedAttempt({ claim, executeAsync, submission: watch.submission });
	try {
		let first;
		do {
			first = await Promise.race([
				original.outcome.then((outcome) => ({ kind: "original" as const, outcome })),
				watch.promise.then((observation) => ({ kind: "watch" as const, observation })),
			]);
		} while (first.kind === "watch" && !watch.isCurrent(first.observation));
		watch.cancel();

		if (first.kind === "original") {
			return await resolveOriginalAsync({
				claim,
				executeAsync,
				outcome: first.outcome,
				readResultAsync,
				submission: watch.submission,
			});
		}

		if (first.observation.status === "failed") {
			process.stderr.write(
				"Warning: could not observe the Open Cloud execution claim; keeping the original task.\n",
			);
			return await resolveOriginalAsync({
				claim,
				executeAsync,
				outcome: await original.outcome,
				readResultAsync,
				submission: watch.submission,
			});
		}

		if (first.observation.status === "found") {
			return await resolveOriginalAsync({
				claim,
				executeAsync,
				outcome: await original.outcome,
				readResultAsync,
				submission: watch.submission,
			});
		}

		process.stderr.write(
			`Warning: Open Cloud task did not claim execution within ${String(Math.round(bootWatchMs / 1000))}s; starting a replacement with the same execution claim.\n`,
		);
		return await resolveHedgeAsync({
			original,
			readResultAsync,
			replacement: createObservedAttempt({
				claim,
				executeAsync,
				submission: watch.submission,
			}),
		});
	} finally {
		original.cancel();
	}
}

async function rescueSubmissionAsync({
	context,
	error,
	executeAsync,
	readResultAsync,
}: {
	readonly context: ExecutionAttemptContext;
	readonly error: UncertainSubmissionError;
	readonly executeAsync: ExecuteAttempt;
	readonly readResultAsync: ReadResult;
}): Promise<ScriptResult> {
	context.observationSignal.throwIfAborted();
	// Not AbortSignal.any: a listener-free composite loses its abort once the
	// aborted source is collected.
	const observation = new AbortController();
	const { signal } = observation;
	context.observationSignal.addEventListener("abort", () => {
		observation.abort(context.observationSignal.reason);
	});
	function cancel(): void {
		observation.abort();
	}

	return resolveHedgeAsync({
		original: { cancel, outcome: settleAsync(error.readResultAsync(signal)) },
		readResultAsync: async (failure, readingSignal) => {
			return readResultAsync(failure, AbortSignal.any([signal, readingSignal]));
		},
		replacement: {
			cancel,
			outcome: settleAsync(executeAsync({ ...context, observationSignal: signal })),
		},
	});
}

function withSubmissionRescue(
	executeAsync: ExecuteAttempt,
	shared: Pick<ExecutionAttemptContext, "claim" | "submission">,
): {
	executeAsync: ExecuteAttempt;
	readResultAsync: ReadResult;
} {
	let canRescue = true;

	async function observeAsync(
		operation: () => Promise<ScriptResult>,
		context: ExecutionAttemptContext,
	): Promise<ScriptResult> {
		try {
			return await operation();
		} catch (err) {
			if (!canRescue || !(err instanceof UncertainSubmissionError)) {
				throw err;
			}

			canRescue = false;
			return rescueSubmissionAsync({ context, error: err, executeAsync, readResultAsync });
		}
	}

	async function readResultAsync(
		error: ExecutionTimeoutError,
		signal: AbortSignal,
	): Promise<ScriptResult> {
		return observeAsync(async () => error.readResultAsync(signal), {
			...shared,
			observationSignal: signal,
		});
	}

	return {
		executeAsync: async (attempt) => observeAsync(async () => executeAsync(attempt), attempt),
		readResultAsync,
	};
}

function createObservedAttempt({
	claim,
	executeAsync,
	submission,
}: {
	claim: string;
	executeAsync: ExecuteAttempt;
	submission: SubmissionLifecycle;
}): ObservedAttempt {
	const observation = new AbortController();
	return {
		cancel: () => {
			observation.abort();
		},
		outcome: settleAsync(
			executeAsync({ claim, observationSignal: observation.signal, submission }),
		),
	};
}

async function resolveOriginalAsync({
	claim,
	executeAsync,
	outcome,
	readResultAsync,
	submission,
}: {
	claim: string;
	executeAsync: ExecuteAttempt;
	outcome: AttemptOutcome;
	readResultAsync: ReadResult;
	submission: SubmissionLifecycle;
}): Promise<ScriptResult> {
	if (outcome.status === "fulfilled") {
		return requireClaim(outcome.result);
	}

	const firstFailure = outcome.failure;
	if (!isPollTimeout(firstFailure)) {
		throw firstFailure;
	}

	process.stderr.write(
		"Warning: Open Cloud task did not finish; retrying once with the same execution claim.\n",
	);
	const observation = new AbortController();
	try {
		return requireClaim(
			await executeAsync({ claim, observationSignal: observation.signal, submission }),
		);
	} catch (err) {
		return await resolveRecoveryAsync({
			firstFailure,
			readResultAsync,
			replacementFailure: err,
		});
	} finally {
		observation.abort();
	}
}
