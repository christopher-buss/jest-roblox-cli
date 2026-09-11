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

export const DEFAULT_BOOT_WATCH_MS = 45_000;

type AttemptOutcome =
	| { failure: unknown; status: "rejected" }
	| { result: ScriptResult; status: "fulfilled" };

type BootObservation = { status: "failed" | "missing" } | { status: "found" };

/**
 * Retry an ambiguous task once; the in-runtime claim admits only one
 * execution.
 */
export async function executeWithRecoveryAsync({
	bootWatchMs = DEFAULT_BOOT_WATCH_MS,
	createKey = randomUUID,
	executeAsync,
	now = Date.now,
	readClaimAsync,
	timeout,
}: {
	bootWatchMs?: number;
	createKey?: () => string;
	executeAsync: (claim: string) => Promise<ScriptResult>;
	now?: () => number;
	readClaimAsync?: (key: string) => Promise<ExecutionClaimObservation>;
	timeout: number;
}): Promise<ScriptResult> {
	// Admit both attempts, including their poll grace and submission overhead.
	const windowMs = 2 * timeout + 180_000;
	const key = createKey();
	const claim = claimSource.replace("__EXECUTION_CLAIM_PARAMETERS__", () => {
		// Keep a minute of retention beyond the last permitted start.
		return `${JSON.stringify(key)}, ${String(now() + windowMs)}, ${String(Math.ceil(windowMs / 1000) + 60)}, ${JSON.stringify(EXECUTION_NOT_CLAIMED)}, ${JSON.stringify(EXECUTION_START_EXPIRED)}`;
	});
	const original = settleAsync(executeAsync(claim));
	const watch = createBootWatch({ key, bootWatchMs, readClaimAsync });
	const first = await Promise.race([
		original.then((outcome) => ({ kind: "original" as const, outcome })),
		watch.promise.then((observation) => ({ kind: "watch" as const, observation })),
	]);

	if (first.kind === "original") {
		watch.cancel();
		return resolveOriginalAsync({ claim, executeAsync, outcome: first.outcome });
	}

	if (first.observation.status === "failed") {
		process.stderr.write(
			"Warning: could not observe the Open Cloud execution claim; keeping the original task.\n",
		);
		return resolveOriginalAsync({ claim, executeAsync, outcome: await original });
	}

	if (first.observation.status === "found") {
		return resolveOriginalAsync({ claim, executeAsync, outcome: await original });
	}

	process.stderr.write(
		`Warning: Open Cloud task did not claim execution within ${String(Math.round(bootWatchMs / 1000))}s; starting a replacement with the same execution claim.\n`,
	);
	return resolveHedgeAsync(original, settleAsync(executeAsync(claim)));
}

function createBootWatch({
	key,
	bootWatchMs,
	readClaimAsync,
}: {
	bootWatchMs: number;
	key: string;
	readClaimAsync: ((key: string) => Promise<ExecutionClaimObservation>) | undefined;
}): { cancel: () => void; promise: Promise<BootObservation> } {
	let timer: ReturnType<typeof setTimeout>;
	const delay = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, bootWatchMs);
	});
	const promise = delay.then(async () => {
		if (readClaimAsync === undefined) {
			return { status: "found" } satisfies BootObservation;
		}

		try {
			const observation = await readClaimAsync(key);
			return { status: observation.status } satisfies BootObservation;
		} catch {
			return { status: "failed" } satisfies BootObservation;
		}
	});

	return {
		cancel: () => {
			clearTimeout(timer);
		},
		promise,
	};
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
	replacementFailure,
}: {
	firstFailure: unknown;
	replacementFailure: unknown;
}): Promise<ScriptResult> {
	const failures = [firstFailure, replacementFailure];
	try {
		if (firstFailure instanceof ExecutionTimeoutError) {
			const original = await firstFailure.readResultAsync();
			if (original !== undefined) {
				return requireClaim(original);
			}
		}
	} catch (err) {
		failures.push(err);
	}

	// Recovery errors must retain the original uncertain execution as cause.
	throw new AggregateError(
		failures,
		`Open Cloud recovery failed: ${failures.map(String).join("\n")}`,
		{ cause: firstFailure },
	);
}

async function resolveOriginalAsync({
	claim,
	executeAsync,
	outcome,
}: {
	claim: string;
	executeAsync: (claim: string) => Promise<ScriptResult>;
	outcome: AttemptOutcome;
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
	try {
		return requireClaim(await executeAsync(claim));
	} catch (err) {
		return resolveRecoveryAsync({ firstFailure, replacementFailure: err });
	}
}

function claimedResult(outcome: AttemptOutcome): ScriptResult | undefined {
	if (outcome.status === "rejected") {
		return undefined;
	}

	return outcome.result.outputs[0] === EXECUTION_NOT_CLAIMED
		? undefined
		: requireClaim(outcome.result);
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
	original: Promise<AttemptOutcome>,
	replacement: Promise<AttemptOutcome>,
): Promise<ScriptResult> {
	const taggedOriginal = original.then((outcome) => ({ attempt: "original" as const, outcome }));
	const taggedReplacement = replacement.then((outcome) => {
		return {
			attempt: "replacement" as const,
			outcome,
		};
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
	return resolveRecoveryAsync({
		firstFailure: failureFrom(originalOutcome),
		replacementFailure: failureFrom(replacementOutcome),
	});
}

async function settleAsync(promise: Promise<ScriptResult>): Promise<AttemptOutcome> {
	try {
		return { result: await promise, status: "fulfilled" };
	} catch (err) {
		return { failure: err, status: "rejected" };
	}
}
