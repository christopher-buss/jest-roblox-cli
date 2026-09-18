import { PollTimeoutError } from "@bedrock-rbx/ocale";
import { ExecutionTimeoutError } from "@isentinel/roblox-runner";
import type { ScriptResult } from "@isentinel/roblox-runner";

import { describe, expect, it, onTestFinished, vi } from "vitest";

import { EXECUTION_NOT_CLAIMED } from "../src/luau/execution-claim.ts";
import { observeDelayedOriginalAsync } from "./e2e/live/execution-claim-helper.ts";

const RECOVERED: ScriptResult = { durationMs: 1, outputs: ["EXECUTED"] };
const DENIED: ScriptResult = { durationMs: 1, outputs: [EXECUTION_NOT_CLAIMED] };
type ObserveScript = (signal: AbortSignal) => Promise<ScriptResult>;
type ReadResult = (signal?: AbortSignal) => Promise<ScriptResult>;

describe("delayed original fixture", () => {
	it("should await the recovered claim beyond the former independent 75 second cutoff", async () => {
		expect.assertions(5);

		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});
		const recoverAsync = vi.fn<ObserveScript>(async (signal) => {
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 90_000);
			});

			expect(signal.aborted).toBeFalse();

			return RECOVERED;
		});
		const executeDelayedAsync = vi.fn<ObserveScript>().mockResolvedValue(DENIED);
		const observed = observeDelayedOriginalAsync({ executeDelayedAsync, recoverAsync });
		await vi.advanceTimersByTimeAsync(75_001);

		expect(executeDelayedAsync).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(14_999);

		await expect(observed).resolves.toStrictEqual([RECOVERED, DENIED]);
		expect(executeDelayedAsync).toHaveBeenCalledExactlyOnceWith(recoverAsync.mock.calls[0]![0]);
		expect(recoverAsync.mock.calls[0]![0].aborted).toBeTrue();
	});

	it("should retain the delayed task's result reader after native polling times out", async () => {
		expect.assertions(5);

		const readResultAsync = vi.fn<ReadResult>(async (signal) => {
			expect(signal!.aborted).toBeFalse();

			return DENIED;
		});
		const timeout = new ExecutionTimeoutError(
			new PollTimeoutError("Still PROCESSING", { timeoutMs: 60_000 }),
			readResultAsync,
		);
		const executeDelayedAsync = vi.fn<ObserveScript>().mockRejectedValue(timeout);

		await expect(
			observeDelayedOriginalAsync({
				executeDelayedAsync,
				recoverAsync: async () => RECOVERED,
			}),
		).resolves.toStrictEqual([RECOVERED, DENIED]);
		expect(executeDelayedAsync).toHaveBeenCalledOnce();
		expect(readResultAsync).toHaveBeenCalledExactlyOnceWith(
			executeDelayedAsync.mock.calls[0]![0],
		);
		expect(executeDelayedAsync.mock.calls[0]![0].aborted).toBeTrue();
	});

	it("should preserve a recovery error without delivering the original", async () => {
		expect.assertions(3);

		const failure = new Error("Recovery failed");
		const recoverAsync = vi.fn<ObserveScript>().mockRejectedValue(failure);
		const executeDelayedAsync = vi.fn<ObserveScript>().mockResolvedValue(DENIED);

		await expect(
			observeDelayedOriginalAsync({ executeDelayedAsync, recoverAsync }),
		).rejects.toBe(failure);
		expect(executeDelayedAsync).not.toHaveBeenCalled();
		expect(recoverAsync.mock.calls[0]![0].aborted).toBeTrue();
	});

	it("should preserve a delayed script error without replaying either execution", async () => {
		expect.assertions(4);

		const failure = new Error("Script failed");
		const executeDelayedAsync = vi.fn<ObserveScript>().mockRejectedValue(failure);
		const recoverAsync = vi.fn<ObserveScript>().mockResolvedValue(RECOVERED);

		await expect(
			observeDelayedOriginalAsync({ executeDelayedAsync, recoverAsync }),
		).rejects.toBe(failure);
		expect(recoverAsync).toHaveBeenCalledOnce();
		expect(executeDelayedAsync).toHaveBeenCalledOnce();
		expect(executeDelayedAsync.mock.calls[0]![0].aborted).toBeTrue();
	});

	it("should preserve a late reader failure and cancel its observation", async () => {
		expect.assertions(3);

		const failure = new Error("Late result unavailable");
		const readResultAsync = vi.fn<ReadResult>().mockRejectedValue(failure);
		const timeout = new ExecutionTimeoutError(
			new PollTimeoutError("Still PROCESSING", { timeoutMs: 60_000 }),
			readResultAsync,
		);

		await expect(
			observeDelayedOriginalAsync({
				executeDelayedAsync: async () => {
					throw timeout;
				},
				recoverAsync: async () => RECOVERED,
			}),
		).rejects.toBe(failure);
		expect(readResultAsync).toHaveBeenCalledOnce();
		expect(readResultAsync.mock.calls[0]![0]!.aborted).toBeTrue();
	});
});
