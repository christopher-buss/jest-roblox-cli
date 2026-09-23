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
import { UncertainSubmissionError } from "./uncertain-submission.ts";

export const DEFAULT_BOOT_WATCH_MS = 45_000;

export interface ExecutionAttemptContext {
	claim: string;
	observationSignal: AbortSignal;
	submission: SubmissionLifecycle;
}

interface SubmissionLifecycle {
	accepted(): void;
}

type ExecuteAttempt = (context: ExecutionAttemptContext) => Promise<ScriptResult>;
type ReadResult = (error: ExecutionTimeoutError, signal: AbortSignal) => Promise<ScriptResult>;

type AttemptOutcome =
	| { failure: unknown; status: "rejected" }
	| { result: ScriptResult; status: "fulfilled" };

type BootObservation = { status: "failed" | "missing" } | { status: "found" };
type WatchedObservation = BootObservation & { generation: object };

interface ObservedAttempt {
	cancel: () => void;
	outcome: Promise<AttemptOutcome>;
}

/**
 * A stalled observer gets one hedge and an ambiguous create gets one rescue;
 * every submission shares the claim that admits only one execution.
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
		return await resolveHedgeAsync(
			original,
			createObservedAttempt({ claim, executeAsync, submission: watch.submission }),
			readResultAsync,
		);
	} finally {
		original.cancel();
	}
}

function requireClaim(result: ScriptResult): ScriptResult {
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

async function resolveRecoveryAsync({
	firstFailure,
	readResultAsync,
	replacementFailure,
}: {
	firstFailure: unknown;
	readResultAsync: ReadResult;
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

async function resolveHedgeAsync(
	original: ObservedAttempt,
	replacement: ObservedAttempt,
	readResultAsync: ReadResult,
): Promise<ScriptResult> {
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

async function settleAsync(promise: Promise<ScriptResult>): Promise<AttemptOutcome> {
	try {
		return { result: await promise, status: "fulfilled" };
	} catch (err) {
		return { failure: err, status: "rejected" };
	}
}

async function rescueSubmissionAsync(
	error: UncertainSubmissionError,
	context: ExecutionAttemptContext,
	executeAsync: ExecuteAttempt,
	readResultAsync: ReadResult,
): Promise<ScriptResult> {
	context.observationSignal.throwIfAborted();
	const observation = new AbortController();
	const signal = AbortSignal.any([context.observationSignal, observation.signal]);
	function cancel(): void {
		observation.abort();
	}

	return resolveHedgeAsync(
		{ cancel, outcome: settleAsync(error.readResultAsync(signal)) },
		{ cancel, outcome: settleAsync(executeAsync({ ...context, observationSignal: signal })) },
		async (failure, readingSignal) => {
			return readResultAsync(failure, AbortSignal.any([signal, readingSignal]));
		},
	);
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
			return rescueSubmissionAsync(err, context, executeAsync, readResultAsync);
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

// eslint-disable-next-line flawless/max-lines-per-function -- timer generation and claim read form one lifecycle
function createBootWatch({
	key,
	bootWatchMs,
	readClaimAsync,
	watchesSubmission,
}: {
	bootWatchMs: number;
	key: string;
	readClaimAsync:
		| ((key: string, signal: AbortSignal) => Promise<ExecutionClaimObservation>)
		| undefined;
	watchesSubmission: boolean;
}): {
	cancel: () => void;
	isCurrent: (observed: WatchedObservation) => boolean;
	promise: Promise<WatchedObservation>;
	submission: SubmissionLifecycle;
} {
	let generation = {};
	let observation: AbortController | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let isCanceled = false;
	let settled = Promise.withResolvers<WatchedObservation>();
	let hasResolved = false;

	function invalidate(): object {
		generation = {};
		clearTimeout(timer);
		observation?.abort();
		observation = undefined;
		if (hasResolved) {
			settled = Promise.withResolvers<WatchedObservation>();
			hasResolved = false;
		}

		return generation;
	}

	function arm(): void {
		if (isCanceled) {
			return;
		}

		const armedGeneration = invalidate();
		timer = setTimeout(() => {
			void observeAsync(armedGeneration);
		}, bootWatchMs);
	}

	async function observeAsync(armedGeneration: object): Promise<void> {
		observation = new AbortController();
		let result: BootObservation;
		try {
			const claim =
				readClaimAsync === undefined
					? ({ status: "found" } satisfies BootObservation)
					: await readClaimAsync(key, observation.signal);
			result = { status: claim.status };
		} catch {
			result = { status: "failed" };
		}

		if (!isCanceled && generation === armedGeneration) {
			hasResolved = true;
			settled.resolve({ ...result, generation: armedGeneration });
		}
	}

	if (!watchesSubmission) {
		arm();
	}

	return {
		cancel: () => {
			isCanceled = true;
			invalidate();
		},
		isCurrent: (observed) => observed.generation === generation,
		get promise() {
			return settled.promise;
		},
		submission: { accepted: arm },
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
