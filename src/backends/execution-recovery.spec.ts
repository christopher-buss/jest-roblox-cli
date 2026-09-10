import { PollTimeoutError } from "@bedrock-rbx/ocale";
import type { ScriptResult } from "@isentinel/roblox-runner";
import { ExecutionTimeoutError } from "@isentinel/roblox-runner";

import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import { EXECUTION_NOT_CLAIMED, EXECUTION_START_EXPIRED } from "../luau/execution-claim.ts";
import { executeWithRecoveryAsync } from "./execution-recovery.ts";

const SUCCESS: ScriptResult = { durationMs: 12, outputs: ["test results"] };
const DECLINED: ScriptResult = {
	durationMs: 1,
	outputs: [EXECUTION_NOT_CLAIMED],
};

function timeoutFailure(): Error {
	return new Error("Execution timed out", {
		cause: new PollTimeoutError("Still PROCESSING", { timeoutMs: 75_000 }),
	});
}

describe("open Cloud execution recovery", () => {
	it("should run a healthy task once without warning", async () => {
		expect.assertions(3);

		const warning = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const executeAsync = vi
			.fn<(claim: string) => Promise<ScriptResult>>()
			.mockResolvedValue(SUCCESS);

		await expect(executeWithRecoveryAsync({ executeAsync, timeout: 30_000 })).resolves.toBe(
			SUCCESS,
		);
		expect(executeAsync).toHaveBeenCalledOnce();
		expect(warning).not.toHaveBeenCalled();
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
