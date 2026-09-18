import type { ExecuteScriptOptions, ScriptResult } from "@isentinel/roblox-runner";
import { OcaleRunner, TaskSubmitError } from "@isentinel/roblox-runner";

import { randomBytes } from "node:crypto";
import process from "node:process";
import { setTimeout as delayAsync } from "node:timers/promises";
import { describe, expect, it } from "vitest";

import { executeWithRecoveryAsync } from "../../../src/backends/execution-recovery.ts";
import { openCloudExecutionBudgets } from "../../../src/backends/open-cloud-budgets.ts";
import { executeWithResultRelayAsync } from "../../../src/backends/result-relay.ts";
import { IS_LIVE } from "./live-gate.ts";

const TASK_TIMEOUT_MS = 30_000;
const TASK_BUDGETS = openCloudExecutionBudgets(TASK_TIMEOUT_MS);
const TEST_OPTIONS = { retry: 0, timeout: TASK_BUDGETS.startupWindowMs + 5000 };

async function hideNativeResultAsync(
	runner: OcaleRunner,
	options: ExecuteScriptOptions & { observationSignal: AbortSignal },
): Promise<ScriptResult> {
	try {
		await runner.executeScriptAsync(options);
	} catch (err) {
		if (err instanceof TaskSubmitError) {
			throw err;
		}
	}

	// Hide native success and failure to require delivery through the relay.
	await delayAsync(TASK_BUDGETS.observationMs, undefined, { signal: options.observationSignal });
	throw new Error("Result relay did not cancel the native observer");
}

function executeWithoutNativeDelivery(script: string): {
	execution: Promise<ScriptResult>;
	nativeSignal: () => AbortSignal | undefined;
} {
	const credentials = {
		apiKey: process.env["ROBLOX_OPEN_CLOUD_API_KEY"]!,
		placeId: process.env["ROBLOX_PLACE_ID"]!,
		universeId: process.env["ROBLOX_UNIVERSE_ID"]!,
	};
	const runner = new OcaleRunner(credentials);
	let nativeSignal: AbortSignal | undefined;
	const execution = executeWithRecoveryAsync({
		executeAsync: async ({ claim, observationSignal, submission }) => {
			return executeWithResultRelayAsync({
				credentials,
				executeAsync: async (wrapped, signal) => {
					nativeSignal = signal;
					return hideNativeResultAsync(runner, {
						observationSignal: signal,
						onSubmitted: submission.accepted,
						retrySubmitTransportErrors: false,
						script: wrapped,
						submitBudget: TASK_BUDGETS.submitBudget,
						submitCapacityBudget: TASK_BUDGETS.submitCapacityBudget,
						timeout: TASK_TIMEOUT_MS,
					});
				},
				runtimeBudget: TASK_TIMEOUT_MS,
				script: `${claim}\n${script}`,
				signal: observationSignal,
				timeout: TASK_BUDGETS.observationMs,
			});
		},
		startupWindowMs: TASK_BUDGETS.startupWindowMs,
		timeout: TASK_TIMEOUT_MS,
		watchesSubmission: true,
	});
	return { execution, nativeSignal: () => nativeSignal };
}

describe("complete result relay", () => {
	it.skipIf(!IS_LIVE)(
		"should return every output when native result delivery stalls",
		TEST_OPTIONS,
		async () => {
			expect.assertions(2);

			// Incompressible output crosses the per-value MemoryStore limit.
			const outputs = [randomBytes(48 * 1024).toString("hex"), "coverage / snapshots"];
			const observed = executeWithoutNativeDelivery(
				`return ${outputs.map((output) => JSON.stringify(output)).join(", ")}`,
			);

			await expect(observed.execution).resolves.toMatchObject({ outputs });
			expect(observed.nativeSignal()!.aborted).toBeTrue();
		},
	);

	it.skipIf(!IS_LIVE)(
		"should report script errors when native result delivery stalls",
		TEST_OPTIONS,
		async () => {
			expect.assertions(2);

			const observed = executeWithoutNativeDelivery('error("relay-failure")');

			await expect(observed.execution).rejects.toThrow("relay-failure");
			expect(observed.nativeSignal()!.aborted).toBeTrue();
		},
	);
});
