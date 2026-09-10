import type { ScriptResult } from "@isentinel/roblox-runner";
import { ExecutionTimeoutError } from "@isentinel/roblox-runner";

import { randomUUID } from "node:crypto";
import process from "node:process";

import claimSource from "../../luau/execution-claim.luau";
import { EXECUTION_NOT_CLAIMED, EXECUTION_START_EXPIRED } from "../luau/execution-claim.ts";
import { isPollTimeout } from "../utils/error-chain.ts";

/**
 * Retry an ambiguous task once; the in-runtime claim admits only one
 * execution.
 */
export async function executeWithRecoveryAsync({
	createKey = randomUUID,
	executeAsync,
	now = Date.now,
	timeout,
}: {
	createKey?: () => string;
	executeAsync: (claim: string) => Promise<ScriptResult>;
	now?: () => number;
	timeout: number;
}): Promise<ScriptResult> {
	// Admit both attempts, including their poll grace and submission overhead.
	const windowMs = 2 * timeout + 180_000;
	const claim = claimSource.replace("__EXECUTION_CLAIM_PARAMETERS__", () => {
		// Keep a minute of retention beyond the last permitted start.
		return `${JSON.stringify(createKey())}, ${String(now() + windowMs)}, ${String(Math.ceil(windowMs / 1000) + 60)}, ${JSON.stringify(EXECUTION_NOT_CLAIMED)}, ${JSON.stringify(EXECUTION_START_EXPIRED)}`;
	});
	let firstFailure: unknown;
	try {
		return requireClaim(await executeAsync(claim));
	} catch (err) {
		if (!isPollTimeout(err)) {
			throw err;
		}

		firstFailure = err;
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
