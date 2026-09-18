import { PollTimeoutError } from "@bedrock-rbx/ocale";
import { ExecutionTimeoutError, OcaleRunner } from "@isentinel/roblox-runner";
import type { ScriptResult } from "@isentinel/roblox-runner";

import { randomUUID } from "node:crypto";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import {
	DEFAULT_BOOT_WATCH_MS,
	executeWithRecoveryAsync,
	type ExecutionAttemptContext,
} from "../../../src/backends/execution-recovery.ts";
import { openCloudExecutionBudgets } from "../../../src/backends/open-cloud-budgets.ts";
import { executeWithResultRelayAsync } from "../../../src/backends/result-relay.ts";
import { IS_LIVE } from "./live-gate.ts";

const TASK_TIMEOUT_MS = 30_000;
const TASK_BUDGETS = openCloudExecutionBudgets(TASK_TIMEOUT_MS);
const TASK_POLL_BUDGET_MS = TASK_TIMEOUT_MS + DEFAULT_BOOT_WATCH_MS;
const RECOVERY_DEADLINE_MS = 2 * TASK_BUDGETS.startupWindowMs;

describe("original execution result", () => {
	it.skipIf(!IS_LIVE)(
		"should recover a completed original after its host observation is lost",
		{ retry: 0, timeout: RECOVERY_DEADLINE_MS + 5000 },
		async () => {
			expect.assertions(4);

			const credentials = {
				apiKey: process.env["ROBLOX_OPEN_CLOUD_API_KEY"]!,
				placeId: process.env["ROBLOX_PLACE_ID"]!,
				universeId: process.env["ROBLOX_UNIVERSE_ID"]!,
			};
			const runner = new OcaleRunner(credentials);
			async function executeScriptAsync({
				isSubmitIdempotent = false,
				observationSignal,
				script,
			}: {
				isSubmitIdempotent?: boolean;
				observationSignal: AbortSignal;
				script: string;
			}): Promise<ScriptResult> {
				return executeWithResultRelayAsync({
					credentials,
					executeAsync: async (wrapped, signal) => {
						return runner.executeScriptAsync({
							isSubmitIdempotent,
							observationSignal: signal,
							pollBudget: TASK_POLL_BUDGET_MS,
							retrySubmitTransportErrors: isSubmitIdempotent,
							script: wrapped,
							submitBudget: TASK_BUDGETS.submitBudget,
							submitCapacityBudget: TASK_BUDGETS.submitCapacityBudget,
							timeout: TASK_TIMEOUT_MS,
						});
					},
					runtimeBudget: TASK_TIMEOUT_MS,
					script,
					signal: observationSignal,
					timeout: TASK_BUDGETS.observationMs,
				});
			}

			const key = randomUUID();
			const startedAt = Date.now();
			const original = await executeWithRecoveryAsync({
				createKey: () => key,
				executeAsync: async ({ claim, observationSignal }) => {
					return executeScriptAsync({
						observationSignal,
						script: `${claim}\nreturn "ORIGINAL"`,
					});
				},
				now: () => startedAt,
				startupWindowMs: TASK_BUDGETS.startupWindowMs,
				timeout: TASK_TIMEOUT_MS,
			});
			const executeAsync = vi
				.fn<(context: ExecutionAttemptContext) => Promise<ScriptResult>>()
				.mockImplementationOnce(async () => {
					throw new ExecutionTimeoutError(
						new Error("Simulated lost host observation", {
							cause: new PollTimeoutError("Simulated lost poll", { timeoutMs: 1 }),
						}),
						async () => original,
					);
				})
				.mockImplementation(async ({ claim, observationSignal }) => {
					return executeScriptAsync({
						isSubmitIdempotent: true,
						observationSignal,
						script: `${claim}\nreturn "DUPLICATE"`,
					});
				});

			const recovered = await executeWithRecoveryAsync({
				createKey: () => key,
				executeAsync,
				now: () => startedAt,
				startupWindowMs: TASK_BUDGETS.startupWindowMs,
				timeout: TASK_TIMEOUT_MS,
			});

			expect(recovered.outputs).toStrictEqual(["ORIGINAL"]);
			expect(executeAsync.mock.calls.length).toBeGreaterThanOrEqual(2);
			expect(executeAsync.mock.calls.length).toBeLessThanOrEqual(3);

			const claims = new Set(executeAsync.mock.calls.map(([context]) => context.claim));

			expect(claims.size).toBe(1);
		},
	);
});
