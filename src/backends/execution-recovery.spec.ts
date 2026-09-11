import { PollTimeoutError } from "@bedrock-rbx/ocale";
import type { ScriptResult } from "@isentinel/roblox-runner";
import { ExecutionTimeoutError } from "@isentinel/roblox-runner";

import process from "node:process";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { EXECUTION_NOT_CLAIMED, EXECUTION_START_EXPIRED } from "../luau/execution-claim.ts";
import { executeWithRecoveryAsync } from "./execution-recovery.ts";

const SUCCESS: ScriptResult = { durationMs: 12, outputs: ["test results"] };
const DECLINED: ScriptResult = {
	durationMs: 1,
	outputs: [EXECUTION_NOT_CLAIMED],
};

function timeoutFailure(message = "Execution timed out"): Error {
	return new Error(message, {
		cause: new PollTimeoutError("Still PROCESSING", { timeoutMs: 75_000 }),
	});
}

describe("open Cloud execution recovery", () => {
	it("should replace an unclaimed task when the boot watchdog expires", async () => {
		expect.assertions(5);

		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});
		const warning = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const original = Promise.withResolvers<ScriptResult>();
		const executeAsync = vi
			.fn<(claim: string) => Promise<ScriptResult>>()
			.mockImplementationOnce(async () => original.promise)
			.mockResolvedValue(SUCCESS);
		const readClaimAsync = vi
			.fn<(key: string) => Promise<{ status: "missing" }>>()
			.mockResolvedValue({ status: "missing" });

		const recovered = executeWithRecoveryAsync({
			bootWatchMs: 1_000,
			createKey: () => "execution-key",
			executeAsync,
			readClaimAsync,
			timeout: 30_000,
		});

		expect({
			executeCount: executeAsync.mock.calls.length,
			readCount: readClaimAsync.mock.calls.length,
		}).toStrictEqual({
			executeCount: 1,
			readCount: 0,
		});

		await vi.advanceTimersByTimeAsync(999);

		expect({
			executeCount: executeAsync.mock.calls.length,
			readCount: readClaimAsync.mock.calls.length,
		}).toStrictEqual({
			executeCount: 1,
			readCount: 0,
		});

		await vi.advanceTimersByTimeAsync(1);

		await expect(recovered).resolves.toBe(SUCCESS);
		expect(readClaimAsync).toHaveBeenCalledExactlyOnceWith("execution-key");
		expect({
			claimsMatch: executeAsync.mock.calls[1]![0] === executeAsync.mock.calls[0]![0],
			warnings: warning.mock.calls.map(([chunk]) => String(chunk)),
		}).toStrictEqual({
			claimsMatch: true,
			warnings: [
				"Warning: Open Cloud task did not claim execution within 1s; starting a replacement with the same execution claim.\n",
			],
		});
	});

	it("should keep polling a task whose claim is visible", async () => {
		expect.assertions(4);

		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});
		const original = Promise.withResolvers<ScriptResult>();
		const executeAsync = vi.fn<(claim: string) => Promise<ScriptResult>>(async () => {
			return original.promise;
		});
		const readClaimAsync = vi
			.fn<() => Promise<{ claim: { claimedAt: number; owner: string }; status: "found" }>>()
			.mockResolvedValue({
				claim: { claimedAt: 500, owner: "server-1" },
				status: "found",
			});
		const recovered = executeWithRecoveryAsync({
			bootWatchMs: 1_000,
			executeAsync,
			readClaimAsync,
			timeout: 30_000,
		});

		await vi.advanceTimersByTimeAsync(1_000);

		expect(readClaimAsync).toHaveBeenCalledOnce();
		expect(executeAsync).toHaveBeenCalledOnce();

		original.resolve(SUCCESS);

		await expect(recovered).resolves.toBe(SUCCESS);
		expect(executeAsync).toHaveBeenCalledOnce();
	});

	it("should keep polling when the execution claim cannot be observed", async () => {
		expect.assertions(4);

		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});
		const warning = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const original = Promise.withResolvers<ScriptResult>();
		const executeAsync = vi.fn<(claim: string) => Promise<ScriptResult>>(async () => {
			return original.promise;
		});
		const readFailure = new Error("MemoryStore unavailable");
		const recovered = executeWithRecoveryAsync({
			bootWatchMs: 1_000,
			executeAsync,
			readClaimAsync: async () => {
				throw readFailure;
			},
			timeout: 30_000,
		});

		await vi.advanceTimersByTimeAsync(1_000);

		expect(executeAsync).toHaveBeenCalledOnce();

		original.resolve(SUCCESS);

		await expect(recovered).resolves.toBe(SUCCESS);
		expect(executeAsync).toHaveBeenCalledOnce();
		expect(warning).toHaveBeenCalledExactlyOnceWith(
			"Warning: could not observe the Open Cloud execution claim; keeping the original task.\n",
		);
	});

	it("should conservatively keep polling when no observer is supplied", async () => {
		expect.assertions(2);

		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});
		const original = Promise.withResolvers<ScriptResult>();
		const executeAsync = vi.fn<(claim: string) => Promise<ScriptResult>>(async () => {
			return original.promise;
		});
		const recovered = executeWithRecoveryAsync({
			executeAsync,
			timeout: 30_000,
		});

		await vi.advanceTimersByTimeAsync(45_000);

		expect(executeAsync).toHaveBeenCalledOnce();

		original.resolve(SUCCESS);

		await expect(recovered).resolves.toBe(SUCCESS);
	});

	it("should use the original claimed result when it beats its hedge", async () => {
		expect.assertions(2);

		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});
		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const original = Promise.withResolvers<ScriptResult>();
		const replacement = Promise.withResolvers<ScriptResult>();
		const executeAsync = vi
			.fn<(claim: string) => Promise<ScriptResult>>()
			.mockReturnValueOnce(original.promise)
			.mockReturnValueOnce(replacement.promise);
		const recovered = executeWithRecoveryAsync({
			bootWatchMs: 1_000,
			executeAsync,
			readClaimAsync: async () => ({ status: "missing" }),
			timeout: 30_000,
		});

		await vi.advanceTimersByTimeAsync(1_000);
		original.resolve(SUCCESS);

		await expect(recovered).resolves.toBe(SUCCESS);
		expect(executeAsync).toHaveBeenCalledTimes(2);
	});

	it("should ignore an unclaimed hedge while the original is still running", async () => {
		expect.assertions(2);

		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});
		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const original = Promise.withResolvers<ScriptResult>();
		const executeAsync = vi
			.fn<(claim: string) => Promise<ScriptResult>>()
			.mockReturnValueOnce(original.promise)
			.mockResolvedValueOnce(DECLINED);
		const recovered = executeWithRecoveryAsync({
			bootWatchMs: 1_000,
			executeAsync,
			readClaimAsync: async () => ({ status: "missing" }),
			timeout: 30_000,
		});

		await vi.advanceTimersByTimeAsync(1_000);
		await vi.waitFor(() => {
			expect(executeAsync).toHaveBeenCalledTimes(2);
		});
		original.resolve(SUCCESS);

		await expect(recovered).resolves.toBe(SUCCESS);
	});

	it("should use the hedge when the original declines first", async () => {
		expect.assertions(1);

		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});
		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const original = Promise.withResolvers<ScriptResult>();
		const replacement = Promise.withResolvers<ScriptResult>();
		const executeAsync = vi
			.fn<(claim: string) => Promise<ScriptResult>>()
			.mockReturnValueOnce(original.promise)
			.mockReturnValueOnce(replacement.promise);
		const recovered = executeWithRecoveryAsync({
			bootWatchMs: 1_000,
			executeAsync,
			readClaimAsync: async () => ({ status: "missing" }),
			timeout: 30_000,
		});

		await vi.advanceTimersByTimeAsync(1_000);
		original.resolve(DECLINED);
		replacement.resolve(SUCCESS);

		await expect(recovered).resolves.toBe(SUCCESS);
	});

	it("should use the original when a rejected hedge finishes first", async () => {
		expect.assertions(1);

		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});
		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const original = Promise.withResolvers<ScriptResult>();
		const replacement = Promise.withResolvers<ScriptResult>();
		const executeAsync = vi
			.fn<(claim: string) => Promise<ScriptResult>>()
			.mockReturnValueOnce(original.promise)
			.mockReturnValueOnce(replacement.promise);
		const recovered = executeWithRecoveryAsync({
			bootWatchMs: 1_000,
			executeAsync,
			readClaimAsync: async () => ({ status: "missing" }),
			timeout: 30_000,
		});

		await vi.advanceTimersByTimeAsync(1_000);
		replacement.reject(timeoutFailure());
		original.resolve(SUCCESS);

		await expect(recovered).resolves.toBe(SUCCESS);
	});

	it("should preserve both failures when the original and hedge stall", async () => {
		expect.assertions(1);

		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});
		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const first = timeoutFailure("Original execution timed out");
		const second = timeoutFailure("Hedged execution timed out");
		const original = Promise.withResolvers<ScriptResult>();
		const replacement = Promise.withResolvers<ScriptResult>();
		const executeAsync = vi
			.fn<(claim: string) => Promise<ScriptResult>>()
			.mockReturnValueOnce(original.promise)
			.mockReturnValueOnce(replacement.promise);
		const recovered = executeWithRecoveryAsync({
			bootWatchMs: 1_000,
			executeAsync,
			readClaimAsync: async () => ({ status: "missing" }),
			timeout: 30_000,
		});

		await vi.advanceTimersByTimeAsync(1_000);
		original.reject(first);
		replacement.reject(second);

		await expect(recovered).rejects.toMatchObject({ cause: first, errors: [first, second] });
	});

	it("should preserve attempt order when the hedge fails first", async () => {
		expect.assertions(1);

		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});
		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const first = new Error("original stalled");
		const second = new Error("hedge stalled");
		const original = Promise.withResolvers<ScriptResult>();
		const replacement = Promise.withResolvers<ScriptResult>();
		const executeAsync = vi
			.fn<(claim: string) => Promise<ScriptResult>>()
			.mockReturnValueOnce(original.promise)
			.mockReturnValueOnce(replacement.promise);
		const recovered = executeWithRecoveryAsync({
			bootWatchMs: 1_000,
			executeAsync,
			readClaimAsync: async () => ({ status: "missing" }),
			timeout: 30_000,
		});

		await vi.advanceTimersByTimeAsync(1_000);
		replacement.reject(second);
		original.reject(first);

		await expect(recovered).rejects.toMatchObject({ cause: first, errors: [first, second] });
	});

	it("should fail when neither hedged task claims execution", async () => {
		expect.assertions(1);

		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});
		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const original = Promise.withResolvers<ScriptResult>();
		const executeAsync = vi
			.fn<(claim: string) => Promise<ScriptResult>>()
			.mockReturnValueOnce(original.promise)
			.mockResolvedValueOnce(DECLINED);
		const recovered = executeWithRecoveryAsync({
			bootWatchMs: 1_000,
			executeAsync,
			readClaimAsync: async () => ({ status: "missing" }),
			timeout: 30_000,
		});

		await vi.advanceTimersByTimeAsync(1_000);
		original.resolve(DECLINED);

		await expect(recovered).rejects.toThrow("refusing to run tests twice");
	});

	it("should diagnose an expired hedged task without waiting for the other task", async () => {
		expect.assertions(1);

		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});
		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const original = Promise.withResolvers<ScriptResult>();
		const executeAsync = vi
			.fn<(claim: string) => Promise<ScriptResult>>()
			.mockReturnValueOnce(original.promise)
			.mockResolvedValueOnce({ durationMs: 0, outputs: [EXECUTION_START_EXPIRED] });
		const recovered = executeWithRecoveryAsync({
			bootWatchMs: 1_000,
			executeAsync,
			readClaimAsync: async () => ({ status: "missing" }),
			timeout: 30_000,
		});
		const diagnosed = recovered.catch((err: unknown) => err);

		await vi.advanceTimersByTimeAsync(1_000);

		await expect(diagnosed).resolves.toMatchObject({
			message:
				"Test execution's start window expired; check the client clock and Open Cloud queue delay.",
		});
	});

	it("should run a healthy task once without warning", async () => {
		expect.assertions(4);

		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});
		const warning = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const executeAsync = vi
			.fn<(claim: string) => Promise<ScriptResult>>()
			.mockResolvedValue(SUCCESS);

		await expect(executeWithRecoveryAsync({ executeAsync, timeout: 30_000 })).resolves.toBe(
			SUCCESS,
		);
		expect(executeAsync).toHaveBeenCalledOnce();
		expect(warning).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("should retry a poll timeout with the same claim and deadline", async () => {
		expect.assertions(4);

		const warning = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const executeAsync = vi
			.fn<(claim: string) => Promise<ScriptResult>>()
			.mockRejectedValueOnce(timeoutFailure())
			.mockResolvedValue(SUCCESS);

		await expect(executeWithRecoveryAsync({ executeAsync, timeout: 30_000 })).resolves.toBe(
			SUCCESS,
		);
		expect(executeAsync).toHaveBeenCalledTimes(2);
		expect(executeAsync.mock.calls[1]).toStrictEqual(executeAsync.mock.calls[0]);
		expect(warning).toHaveBeenCalledExactlyOnceWith(
			"Warning: Open Cloud task did not finish; retrying once with the same execution claim.\n",
		);
	});

	it("should give independent tasks distinct keys and bounded startup windows", async () => {
		expect.assertions(4);

		function now(): number {
			return 1_000_000;
		}

		const executeAsync = vi
			.fn<(claim: string) => Promise<ScriptResult>>()
			.mockResolvedValue(SUCCESS);
		await executeWithRecoveryAsync({ executeAsync, now, timeout: 30_001 });
		await executeWithRecoveryAsync({ executeAsync, now, timeout: 30_001 });
		const [first, second] = executeAsync.mock.calls;

		expect(first![0]).toContain(", 1240002, 301");
		expect(first![0]).toMatch(
			/local key, startBefore, retention, notClaimed, startExpired = "[\da-f-]{36}"/,
		);
		expect(first![0]).not.toContain("__EXECUTION_CLAIM_PARAMETERS__");
		expect(first).not.toStrictEqual(second);
	});

	it.for([new Error("Script FAILED"), new Error("HTTP 401"), "transport rejected"])(
		"should propagate a non-poll failure without retry: %s",
		async (failure) => {
			expect.assertions(2);

			const executeAsync = vi
				.fn<(claim: string) => Promise<ScriptResult>>()
				.mockRejectedValue(failure);

			await expect(executeWithRecoveryAsync({ executeAsync, timeout: 30_000 })).rejects.toBe(
				failure,
			);
			expect(executeAsync).toHaveBeenCalledOnce();
		},
	);

	it("should fail after two stuck tasks", async () => {
		expect.assertions(2);

		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const failure = timeoutFailure();
		const executeAsync = vi
			.fn<(claim: string) => Promise<ScriptResult>>()
			.mockRejectedValue(failure);

		await expect(
			executeWithRecoveryAsync({ executeAsync, timeout: 30_000 }),
		).rejects.toMatchObject({
			cause: failure,
			errors: [failure, failure],
			message: `Open Cloud recovery failed: ${String(failure)}\n${String(failure)}`,
		});
		expect(executeAsync).toHaveBeenCalledTimes(2);
	});

	it("should retain the original timeout when the replacement cannot claim execution", async () => {
		expect.assertions(3);

		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const failure = timeoutFailure();
		const executeAsync = vi
			.fn<(claim: string) => Promise<ScriptResult>>()
			.mockRejectedValueOnce(failure)
			.mockResolvedValue(DECLINED);
		const caught = await executeWithRecoveryAsync({ executeAsync, timeout: 30_000 }).catch(
			(err: unknown) => err,
		);

		expect(caught).toHaveProperty("cause", failure);
		expect(caught).toHaveProperty(
			"message",
			`Open Cloud recovery failed: ${String(failure)}\nError: Test execution was already claimed; refusing to run tests twice.`,
		);
		expect(executeAsync).toHaveBeenCalledTimes(2);
	});

	it("should recover the original result when the replacement declines execution", async () => {
		expect.assertions(3);

		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const readResultAsync = vi
			.fn<() => Promise<ScriptResult | undefined>>()
			.mockResolvedValue(SUCCESS);
		const failure = new ExecutionTimeoutError(timeoutFailure(), readResultAsync);
		const executeAsync = vi
			.fn<(claim: string) => Promise<ScriptResult>>()
			.mockRejectedValueOnce(failure)
			.mockResolvedValue(DECLINED);

		await expect(executeWithRecoveryAsync({ executeAsync, timeout: 30_000 })).resolves.toBe(
			SUCCESS,
		);
		expect(readResultAsync).toHaveBeenCalledOnce();
		expect(executeAsync).toHaveBeenCalledTimes(2);
	});

	it("should use a replacement result without re-reading an unclaimed original", async () => {
		expect.assertions(2);

		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const readResultAsync = vi.fn<() => Promise<ScriptResult | undefined>>();
		const failure = new ExecutionTimeoutError(timeoutFailure(), readResultAsync);
		const executeAsync = vi
			.fn<(claim: string) => Promise<ScriptResult>>()
			.mockRejectedValueOnce(failure)
			.mockResolvedValue(SUCCESS);

		await expect(executeWithRecoveryAsync({ executeAsync, timeout: 30_000 })).resolves.toBe(
			SUCCESS,
		);
		expect(readResultAsync).not.toHaveBeenCalled();
	});

	it("should recover a late original even when the replacement times out", async () => {
		expect.assertions(2);

		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const readResultAsync = vi
			.fn<() => Promise<ScriptResult | undefined>>()
			.mockResolvedValue(SUCCESS);
		const first = new ExecutionTimeoutError(timeoutFailure(), readResultAsync);
		const executeAsync = vi
			.fn<(claim: string) => Promise<ScriptResult>>()
			.mockRejectedValueOnce(first)
			.mockRejectedValue(timeoutFailure());

		await expect(executeWithRecoveryAsync({ executeAsync, timeout: 30_000 })).resolves.toBe(
			SUCCESS,
		);
		expect(readResultAsync).toHaveBeenCalledOnce();
	});

	it("should never treat a declined original as test results", async () => {
		expect.assertions(2);

		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const first = new ExecutionTimeoutError(timeoutFailure(), async () => DECLINED);
		const executeAsync = vi
			.fn<(claim: string) => Promise<ScriptResult>>()
			.mockRejectedValueOnce(first)
			.mockResolvedValue(DECLINED);

		await expect(executeWithRecoveryAsync({ executeAsync, timeout: 30_000 })).rejects.toThrow(
			"refusing to run tests twice",
		);
		expect(executeAsync).toHaveBeenCalledTimes(2);
	});

	it("should fail with the original task diagnosis if it still has no result", async () => {
		expect.assertions(2);

		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const failure = new ExecutionTimeoutError(timeoutFailure(), async () => {});
		const executeAsync = vi
			.fn<(claim: string) => Promise<ScriptResult>>()
			.mockRejectedValueOnce(failure)
			.mockResolvedValue(DECLINED);

		await expect(
			executeWithRecoveryAsync({ executeAsync, timeout: 30_000 }),
		).rejects.toMatchObject({
			cause: failure,
			message: `Open Cloud recovery failed: ${String(failure)}\nError: Test execution was already claimed; refusing to run tests twice.`,
		});
		expect(executeAsync).toHaveBeenCalledTimes(2);
	});

	it("should retain an uncertain execution as cause if reading its result fails", async () => {
		expect.assertions(2);

		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const readFailure = new Error("HTTP 404 on original result read");
		const failure = new ExecutionTimeoutError(timeoutFailure(), async () => {
			throw readFailure;
		});
		const executeAsync = vi
			.fn<(claim: string) => Promise<ScriptResult>>()
			.mockRejectedValueOnce(failure)
			.mockResolvedValue(DECLINED);

		await expect(
			executeWithRecoveryAsync({ executeAsync, timeout: 30_000 }),
		).rejects.toMatchObject({
			cause: failure,
			errors: [failure, expect.any(Error), readFailure],
			message: `Open Cloud recovery failed: ${String(failure)}\nError: Test execution was already claimed; refusing to run tests twice.\n${String(readFailure)}`,
		});
		expect(executeAsync).toHaveBeenCalledTimes(2);
	});

	it("should fail without retry when the first task cannot claim execution", async () => {
		expect.assertions(2);

		const executeAsync = vi
			.fn<(claim: string) => Promise<ScriptResult>>()
			.mockResolvedValue(DECLINED);

		await expect(
			executeWithRecoveryAsync({ executeAsync, timeout: 30_000 }),
		).rejects.toMatchObject({
			message: "Test execution was already claimed; refusing to run tests twice.",
		});
		expect(executeAsync).toHaveBeenCalledOnce();
	});

	it("should leave missing outputs and test failures to the result parser", async () => {
		expect.assertions(1);

		const result: ScriptResult = { durationMs: 4, outputs: [] };
		const executeAsync = vi
			.fn<(claim: string) => Promise<ScriptResult>>()
			.mockResolvedValue(result);

		await expect(executeWithRecoveryAsync({ executeAsync, timeout: 30_000 })).resolves.toBe(
			result,
		);
	});

	it("should diagnose an expired startup window without retrying", async () => {
		expect.assertions(2);

		const executeAsync = vi
			.fn<(claim: string) => Promise<ScriptResult>>()
			.mockResolvedValue({ durationMs: 0, outputs: [EXECUTION_START_EXPIRED] });

		await expect(executeWithRecoveryAsync({ executeAsync, timeout: 30_000 })).rejects.toThrow(
			"Test execution's start window expired; check the client clock and Open Cloud queue delay.",
		);
		expect(executeAsync).toHaveBeenCalledOnce();
	});

	it("should preserve the original, replacement and read failures", async () => {
		expect.assertions(1);

		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const readFailure = new Error("Read failed");
		const first = new ExecutionTimeoutError(timeoutFailure(), async () => {
			throw readFailure;
		});
		const second = timeoutFailure();
		const executeAsync = vi
			.fn<(claim: string) => Promise<ScriptResult>>()
			.mockRejectedValueOnce(first)
			.mockRejectedValue(second);

		await expect(
			executeWithRecoveryAsync({ executeAsync, timeout: 30_000 }),
		).rejects.toMatchObject({ cause: first, errors: [first, second, readFailure] });
	});

	it("should use the supplied claim identity and clock", async () => {
		expect.assertions(1);

		const executeAsync = vi
			.fn<(claim: string) => Promise<ScriptResult>>()
			.mockResolvedValue(SUCCESS);
		await executeWithRecoveryAsync({
			createKey: () => "execution-key",
			executeAsync,
			now: () => 1000,
			timeout: 30_000,
		});

		expect(executeAsync).toHaveBeenCalledExactlyOnceWith(
			expect.stringContaining(
				'"execution-key", 241000, 300, "__JEST_ROBLOX_EXECUTION_NOT_CLAIMED__", "__JEST_ROBLOX_EXECUTION_START_EXPIRED__"',
			),
		);
	});
});
