import { PollTimeoutError } from "@bedrock-rbx/ocale";
import { OcaleRunner } from "@isentinel/roblox-runner";
import type { ScriptResult } from "@isentinel/roblox-runner";

import process from "node:process";
import { assert, describe, expect, it, vi } from "vitest";

import {
	DEFAULT_BOOT_WATCH_MS,
	executeWithRecoveryAsync,
	type ExecutionAttemptContext,
} from "../../../src/backends/execution-recovery.ts";
import { openCloudExecutionBudgets } from "../../../src/backends/open-cloud-budgets.ts";
import { executeWithResultRelayAsync } from "../../../src/backends/result-relay.ts";
import {
	EXECUTION_NOT_CLAIMED,
	ExecutionClaimObserver,
} from "../../../src/luau/execution-claim.ts";
import { observeDelayedOriginalAsync } from "./execution-claim-helper.ts";
import { IS_BINARY_INPUT, IS_LIVE } from "./live-gate.ts";

const TASK_TIMEOUT_MS = 30_000;
const TASK_BUDGETS = openCloudExecutionBudgets(TASK_TIMEOUT_MS);
const RECOVERY_DEADLINE_MS = TASK_BUDGETS.startupWindowMs;
const DELAYED_TIMEOUT_MS = 15_000;
const DELAYED_DEADLINE_MS =
	openCloudExecutionBudgets(DELAYED_TIMEOUT_MS).observationMs +
	DELAYED_TIMEOUT_MS +
	DEFAULT_BOOT_WATCH_MS;
const DELAYED_CLAIM_WINDOW_MS = RECOVERY_DEADLINE_MS + DELAYED_DEADLINE_MS;

describe("execution claim", () => {
	const credentials = {
		apiKey: process.env["ROBLOX_OPEN_CLOUD_API_KEY"]!,
		placeId: process.env["ROBLOX_PLACE_ID"]!,
		universeId: process.env["ROBLOX_UNIVERSE_ID"]!,
	};
	const runner = new OcaleRunner(credentials);
	async function executeClaimedScriptAsync({
		isSubmitIdempotent = false,
		onSubmitted,
		script,
		signal,
		timeout = TASK_TIMEOUT_MS,
	}: {
		isSubmitIdempotent?: boolean;
		onSubmitted?: () => void;
		script: string;
		signal?: AbortSignal;
		timeout?: number;
	}): Promise<ScriptResult> {
		const budgets = openCloudExecutionBudgets(timeout);
		return executeWithResultRelayAsync({
			credentials,
			executeAsync: async (wrapped, relaySignal) => {
				return runner.executeScriptAsync({
					isSubmitIdempotent,
					observationSignal: relaySignal,
					...(onSubmitted === undefined ? {} : { onSubmitted }),
					retrySubmitTransportErrors: isSubmitIdempotent,
					script: wrapped,
					submitBudget: budgets.submitBudget,
					submitCapacityBudget: budgets.submitCapacityBudget,
					timeout,
				});
			},
			runtimeBudget: timeout,
			script,
			...(signal === undefined ? {} : { signal }),
			timeout: budgets.observationMs,
		});
	}

	it.skipIf(!IS_LIVE || !IS_BINARY_INPUT)(
		"should replace an accepted execution whose observation never reaches its claim",
		{
			retry: 0,
			timeout: RECOVERY_DEADLINE_MS + 6000,
		},
		async () => {
			expect.assertions(5);

			const replacementStarted = Promise.withResolvers<void>();
			const executeAsync = vi
				.fn<(context: ExecutionAttemptContext) => Promise<ScriptResult>>()
				.mockImplementationOnce(async ({ observationSignal, submission }) => {
					submission.accepted();
					await new Promise<void>((resolve, reject) => {
						function abort(): void {
							reject(new Error("Original observation was superseded"));
						}

						observationSignal.addEventListener("abort", abort, { once: true });
						void replacementStarted.promise.then(() => {
							observationSignal.removeEventListener("abort", abort);
							resolve();
						});
					});
					throw new PollTimeoutError("Simulated lost poll", { timeoutMs: 1 });
				})
				.mockImplementation(async ({ claim, observationSignal, submission }) => {
					replacementStarted.resolve();
					return executeClaimedScriptAsync({
						onSubmitted: () => {
							submission.accepted();
						},
						script: `${claim}\nreturn "EXECUTED"`,
						signal: observationSignal,
					});
				});
			const observer = new ExecutionClaimObserver({ credentials });
			const startedAt = performance.now();
			const recovered = await executeWithRecoveryAsync({
				bootWatchMs: 1_000,
				executeAsync,
				readClaimAsync: observer.readAsync.bind(observer),
				startupWindowMs: TASK_BUDGETS.startupWindowMs,
				timeout: TASK_TIMEOUT_MS,
				watchesSubmission: true,
			});
			const elapsedMs = performance.now() - startedAt;

			expect(recovered.outputs).toStrictEqual(["EXECUTED"]);
			expect(elapsedMs).toBeGreaterThanOrEqual(1_000);
			expect(executeAsync.mock.calls.length).toBeGreaterThanOrEqual(2);
			expect(executeAsync.mock.calls.length).toBeLessThanOrEqual(3);

			const claims = new Set(executeAsync.mock.calls.map(([context]) => context.claim));

			expect(claims.size).toBe(1);
		},
	);

	it.skipIf(!IS_LIVE || !IS_BINARY_INPUT)(
		"should refuse a delayed original after recovery claims execution on Roblox",
		{
			retry: 0,
			timeout: DELAYED_CLAIM_WINDOW_MS + 5000,
		},
		async () => {
			expect.assertions(5);

			let originalScript: string | undefined;
			const executeAsync =
				vi.fn<(context: ExecutionAttemptContext) => Promise<ScriptResult>>();
			const [recovered, delayed] = await observeDelayedOriginalAsync({
				executeDelayedAsync: async (signal) => {
					assert(originalScript !== undefined);
					return executeClaimedScriptAsync({
						// The recovered result proves every replay returns the
						// same denial.
						isSubmitIdempotent: true,
						script: originalScript,
						signal,
						timeout: DELAYED_TIMEOUT_MS,
					});
				},
				recoverAsync: async (signal) => {
					executeAsync
						.mockImplementationOnce(async ({ claim }) => {
							// Hold delivery on the host without occupying a
							// Roblox task slot.
							originalScript = `${claim}\nreturn "DUPLICATE"`;
							throw new PollTimeoutError("Simulated lost poll", { timeoutMs: 1 });
						})
						.mockImplementation(async ({ claim, observationSignal, submission }) => {
							return executeClaimedScriptAsync({
								onSubmitted: () => {
									submission.accepted();
								},
								script: `${claim}\nreturn "EXECUTED"`,
								signal: AbortSignal.any([observationSignal, signal]),
							});
						});
					return executeWithRecoveryAsync({
						executeAsync,
						startupWindowMs: DELAYED_CLAIM_WINDOW_MS,
						timeout: TASK_TIMEOUT_MS,
					});
				},
			});

			expect(recovered.outputs).toStrictEqual(["EXECUTED"]);
			expect(delayed.outputs).toStrictEqual([EXECUTION_NOT_CLAIMED]);
			expect(executeAsync.mock.calls.length).toBeGreaterThanOrEqual(2);
			expect(executeAsync.mock.calls.length).toBeLessThanOrEqual(3);

			const claims = new Set(executeAsync.mock.calls.map(([context]) => context.claim));

			expect(claims.size).toBe(1);
		},
	);
});
