import { PollTimeoutError } from "@bedrock-rbx/ocale";
import type { ScriptResult } from "@isentinel/roblox-runner";
import { ExecutionTimeoutError } from "@isentinel/roblox-runner";

import process from "node:process";
import { setTimeout as delayAsync, setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import {
	EXECUTION_NOT_CLAIMED,
	EXECUTION_START_EXPIRED,
	type ExecutionClaimObservation,
} from "../luau/execution-claim.ts";
import { executeWithRecoveryAsync, type ExecutionAttemptContext } from "./execution-recovery.ts";
import { UncertainSubmissionError } from "./uncertain-submission.ts";

type ExecuteAttempt = (context: ExecutionAttemptContext) => Promise<ScriptResult>;

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
	it("should not submit a rescue after another attempt has already won", async () => {
		expect.assertions(2);

		const original = Promise.withResolvers<ScriptResult>();
		const executeAsync = vi
			.fn<ExecuteAttempt>()
			.mockImplementationOnce(async ({ submission }) => {
				submission.accepted();
				return original.promise;
			})
			.mockResolvedValue(SUCCESS);

		await expect(
			executeWithRecoveryAsync({
				bootWatchMs: 0,
				executeAsync,
				readClaimAsync: async () => ({ status: "missing" }),
				timeout: 30_000,
				watchesSubmission: true,
			}),
		).resolves.toBe(SUCCESS);

		original.reject(
			new UncertainSubmissionError(new Error("late POST failure"), async () => DECLINED),
		);
		await nextTurn();

		expect(executeAsync).toHaveBeenCalledTimes(2);
	});

	/**
	 * The original's claim read is still in flight when its poll runs out and
	 * the replacement is accepted. Whatever that read comes back with belongs
	 * to a watch that has been re-armed, and must not settle the new one.
	 */
	it("should ignore a stale claim read once a replacement submission is accepted", async () => {
		expect.assertions(3);

		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});
		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const original = Promise.withResolvers<ScriptResult>();
		const staleRead = Promise.withResolvers<{ status: "missing" }>();
		const executeAsync = vi
			.fn<ExecuteAttempt>()
			.mockImplementationOnce(async ({ submission }) => {
				submission.accepted();
				return original.promise;
			})
			.mockImplementationOnce(async ({ submission }) => {
				submission.accepted();
				return SUCCESS;
			});
		const readClaimAsync = vi
			.fn<() => Promise<{ status: "missing" }>>()
			.mockImplementationOnce(async () => staleRead.promise)
			.mockResolvedValue({ status: "missing" });
		const recovered = executeWithRecoveryAsync({
			bootWatchMs: 1_000,
			executeAsync,
			readClaimAsync,
			timeout: 30_000,
			watchesSubmission: true,
		});
		await vi.advanceTimersByTimeAsync(1_000);

		expect(readClaimAsync).toHaveBeenCalledOnce();

		original.reject(timeoutFailure());
		await vi.advanceTimersByTimeAsync(0);
		staleRead.resolve({ status: "missing" });
		await vi.advanceTimersByTimeAsync(60_000);

		await expect(recovered).resolves.toBe(SUCCESS);
		expect(executeAsync).toHaveBeenCalledTimes(2);
	});

	it("should cancel a nested native result reread when the ordinary hedge wins", async () => {
		expect.assertions(3);

		const original = Promise.withResolvers<ScriptResult>();
		const hedge = Promise.withResolvers<ScriptResult>();
		const hedgeStarted = Promise.withResolvers<void>();
		const reading = Promise.withResolvers<AbortSignal | undefined>();
		const nativeResult = Promise.withResolvers<ScriptResult>();
		onTestFinished(() => {
			nativeResult.resolve(DECLINED);
		});
		const executeAsync = vi
			.fn<ExecuteAttempt>()
			.mockImplementationOnce(async ({ submission }) => {
				submission.accepted();
				return original.promise;
			})
			.mockImplementationOnce(async () => {
				hedgeStarted.resolve();
				return hedge.promise;
			})
			.mockRejectedValueOnce(
				new ExecutionTimeoutError(timeoutFailure(), async (signal) => {
					reading.resolve(signal);
					return nativeResult.promise;
				}),
			);
		const execution = executeWithRecoveryAsync({
			bootWatchMs: 0,
			executeAsync,
			readClaimAsync: async () => ({ status: "missing" }),
			timeout: 30_000,
			watchesSubmission: true,
		});
		await hedgeStarted.promise;
		original.reject(
			new UncertainSubmissionError(new Error("POST 500"), async () => {
				throw new Error("relay unavailable");
			}),
		);
		const signal = await reading.promise;

		expect(signal!.aborted).toBeFalse();

		hedge.resolve(SUCCESS);

		await expect(execution).resolves.toBe(SUCCESS);
		expect(signal!.aborted).toBeTrue();
	});

	it("should release a failed rescue while the outer hedge still owns the shared rescue limit", async () => {
		expect.assertions(5);

		const original = Promise.withResolvers<ScriptResult>();
		const hedge = Promise.withResolvers<ScriptResult>();
		const hedgeStarted = Promise.withResolvers<void>();
		const rescued = Promise.withResolvers<ScriptResult>();
		const rescueStarted = Promise.withResolvers<void>();
		const executeAsync = vi
			.fn<ExecuteAttempt>()
			.mockImplementationOnce(async ({ submission }) => {
				submission.accepted();
				return original.promise;
			})
			.mockImplementationOnce(async () => {
				hedgeStarted.resolve();
				return hedge.promise;
			})
			.mockImplementationOnce(async () => {
				rescueStarted.resolve();
				return rescued.promise;
			})
			.mockResolvedValue(SUCCESS);
		const execution = executeWithRecoveryAsync({
			bootWatchMs: 0,
			executeAsync,
			readClaimAsync: async () => ({ status: "missing" }),
			timeout: 30_000,
			watchesSubmission: true,
		});
		await hedgeStarted.promise;
		original.reject(
			new UncertainSubmissionError(new Error("first POST 500"), async () => {
				throw new Error("no first relay");
			}),
		);
		await rescueStarted.promise;
		rescued.reject(new Error("rescue refused"));
		await nextTurn();

		expect(executeAsync.mock.calls[2]![0].observationSignal.aborted).toBeTrue();
		expect(executeAsync.mock.calls[0]![0].observationSignal.aborted).toBeFalse();

		hedge.reject(
			new UncertainSubmissionError(new Error("second POST 500"), async () => SUCCESS),
		);

		await expect(execution).resolves.toBe(SUCCESS);
		expect(executeAsync).toHaveBeenCalledTimes(3);
		expect(
			executeAsync.mock.calls.map(([context]) => context.observationSignal.aborted),
		).toStrictEqual([true, true, true]);
	});

	it("should retain an accepted ambiguous create when its fresh rescue loses the claim", async () => {
		expect.assertions(4);

		const original = Promise.withResolvers<ScriptResult>();
		const rescueStarted = Promise.withResolvers<void>();
		const reader = vi.fn<() => Promise<ScriptResult>>(async () => original.promise);
		const executeAsync = vi
			.fn<ExecuteAttempt>()
			.mockRejectedValueOnce(new UncertainSubmissionError(new Error("POST 500"), reader))
			.mockImplementationOnce(async () => {
				rescueStarted.resolve();
				return DECLINED;
			});
		const execution = executeWithRecoveryAsync({ executeAsync, timeout: 30_000 });
		await rescueStarted.promise;

		expect(executeAsync).toHaveBeenCalledTimes(2);

		original.resolve(SUCCESS);

		await expect(execution).resolves.toBe(SUCCESS);
		expect(executeAsync.mock.calls[0]![0].claim).toBe(executeAsync.mock.calls[1]![0].claim);
		expect(
			executeAsync.mock.calls.map(([context]) => context.observationSignal.aborted),
		).toStrictEqual([true, true]);
	});

	it("should rescue one ambiguous replacement after the original poll timeout", async () => {
		expect.assertions(2);

		const executeAsync = vi
			.fn<ExecuteAttempt>()
			.mockRejectedValueOnce(timeoutFailure())
			.mockRejectedValueOnce(
				new UncertainSubmissionError(new Error("POST 500"), async () => DECLINED),
			)
			.mockResolvedValueOnce(SUCCESS);

		await expect(executeWithRecoveryAsync({ executeAsync, timeout: 30_000 })).resolves.toBe(
			SUCCESS,
		);
		expect(executeAsync).toHaveBeenCalledTimes(3);
	});

	it("should stop after one ambiguous-create rescue when both requests fail", async () => {
		expect.assertions(2);

		const executeAsync = vi.fn<ExecuteAttempt>().mockRejectedValue(
			new UncertainSubmissionError(new Error("POST 500"), async () => {
				throw new Error("no original relay");
			}),
		);

		await expect(executeWithRecoveryAsync({ executeAsync, timeout: 30_000 })).rejects.toThrow(
			"no original relay",
		);
		expect(executeAsync).toHaveBeenCalledTimes(2);
	});

	it.for<ExecutionClaimObservation>([
		{ status: "missing" },
		{ claim: { claimedAt: 1, owner: "original" }, status: "found" },
		{ error: new Error("claim read failed"), status: "failed" },
	])("should stop the watchdog after consuming a $status observation", async (observation) => {
		expect.assertions(3);

		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});
		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const original = Promise.withResolvers<ScriptResult>();
		const readClaimAsync = vi
			.fn<() => Promise<ExecutionClaimObservation>>()
			.mockResolvedValue(observation);
		const executeAsync = vi
			.fn<ExecuteAttempt>()
			.mockImplementationOnce(async ({ submission }) => {
				submission.accepted();
				return original.promise;
			})
			.mockImplementationOnce(async ({ submission }) => {
				submission.accepted();
				return SUCCESS;
			});
		const recovered = executeWithRecoveryAsync({
			bootWatchMs: 1_000,
			executeAsync,
			readClaimAsync,
			timeout: 30_000,
			watchesSubmission: true,
		});
		await vi.advanceTimersByTimeAsync(1_000);
		original.reject(timeoutFailure());

		await expect(recovered).resolves.toBe(SUCCESS);
		expect(vi.getTimerCount()).toBe(0);

		await vi.advanceTimersByTimeAsync(1_000);

		expect(readClaimAsync).toHaveBeenCalledOnce();
	});

	it("should cancel a claim read when the original returns during observation", async () => {
		expect.assertions(2);

		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});
		const original = Promise.withResolvers<ScriptResult>();
		const observed = Promise.withResolvers<AbortSignal>();
		const recovered = executeWithRecoveryAsync({
			bootWatchMs: 1_000,
			executeAsync: async () => original.promise,
			readClaimAsync: async (_key, signal) => {
				observed.resolve(signal);
				return new Promise(() => {});
			},
			timeout: 30_000,
		});
		await vi.advanceTimersByTimeAsync(1_000);
		original.resolve(SUCCESS);

		await expect(recovered).resolves.toBe(SUCCESS);

		const signal = await observed.promise;

		expect(signal.aborted).toBeTrue();
	});

	it("should cancel a submission-delayed watchdog when the task settles first", async () => {
		expect.assertions(2);

		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});
		let accept: (() => void) | undefined;
		const readClaimAsync = vi.fn<() => Promise<{ status: "missing" }>>(async () => {
			return { status: "missing" };
		});

		await expect(
			executeWithRecoveryAsync({
				executeAsync: async ({ submission }) => {
					accept = submission.accepted;
					return SUCCESS;
				},
				readClaimAsync,
				timeout: 30_000,
				watchesSubmission: true,
			}),
		).resolves.toBe(SUCCESS);

		accept!();
		await vi.advanceTimersByTimeAsync(60_000);

		expect(readClaimAsync).not.toHaveBeenCalled();
	});

	it("should start watching for a claim only after submission is accepted", async () => {
		expect.assertions(3);

		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});
		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const original = Promise.withResolvers<ScriptResult>();
		let accept: (() => void) | undefined;
		const executeAsync = vi
			.fn<ExecuteAttempt>()
			.mockImplementationOnce(async ({ submission }) => {
				accept = submission.accepted;
				return original.promise;
			})
			.mockResolvedValue(SUCCESS);
		const readClaimAsync = vi.fn<() => Promise<{ status: "missing" }>>(async () => {
			return { status: "missing" };
		});
		const recovered = executeWithRecoveryAsync({
			bootWatchMs: 1_000,
			executeAsync,
			readClaimAsync,
			timeout: 30_000,
			watchesSubmission: true,
		});
		await vi.advanceTimersByTimeAsync(60_000);

		expect(executeAsync).toHaveBeenCalledOnce();
		expect(readClaimAsync).not.toHaveBeenCalled();

		accept!();
		await vi.advanceTimersByTimeAsync(1_000);

		await expect(recovered).resolves.toBe(SUCCESS);
	});

	it("should replace an unclaimed task when the boot watchdog expires", async () => {
		expect.assertions(5);

		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});
		const warning = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const original = Promise.withResolvers<ScriptResult>();
		const executeAsync = vi
			.fn<ExecuteAttempt>()
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
		expect(readClaimAsync).toHaveBeenCalledExactlyOnceWith(
			"execution-key",
			expect.any(AbortSignal),
		);
		expect({
			claimsMatch:
				executeAsync.mock.calls[1]![0].claim === executeAsync.mock.calls[0]![0].claim,
			observationsAborted: executeAsync.mock.calls.map(
				([context]) => context.observationSignal.aborted,
			),
			warnings: warning.mock.calls.map(([chunk]) => String(chunk)),
		}).toStrictEqual({
			claimsMatch: true,
			observationsAborted: [true, true],
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
		const executeAsync = vi.fn<ExecuteAttempt>(async () => original.promise);
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
		const executeAsync = vi.fn<ExecuteAttempt>(async () => original.promise);
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
		const executeAsync = vi.fn<ExecuteAttempt>(async () => original.promise);
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
		expect.assertions(3);

		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});
		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const original = Promise.withResolvers<ScriptResult>();
		const replacement = Promise.withResolvers<ScriptResult>();
		const executeAsync = vi
			.fn<ExecuteAttempt>()
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
		expect(
			executeAsync.mock.calls.map(([context]) => context.observationSignal.aborted),
		).toStrictEqual([true, true]);
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
			.fn<ExecuteAttempt>()
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
			.fn<ExecuteAttempt>()
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
			.fn<ExecuteAttempt>()
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
			.fn<ExecuteAttempt>()
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
			.fn<ExecuteAttempt>()
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
			.fn<ExecuteAttempt>()
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

	it("should preserve the original result when its replacement starts after expiry", async () => {
		expect.assertions(3);

		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});
		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const original = Promise.withResolvers<ScriptResult>();
		const executeAsync = vi
			.fn<ExecuteAttempt>()
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
		original.resolve(SUCCESS);

		await expect(diagnosed).resolves.toBe(SUCCESS);
		expect(executeAsync).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("should retain expiry diagnostics when neither hedge can produce results", async () => {
		expect.assertions(3);

		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});
		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const original = Promise.withResolvers<ScriptResult>();
		const failure = new Error("original task failed");
		const executeAsync = vi
			.fn<ExecuteAttempt>()
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
		original.reject(failure);

		await expect(diagnosed).resolves.toMatchObject({
			cause: failure,
			errors: [
				failure,
				expect.objectContaining({
					message: expect.stringContaining("start window expired"),
				}),
			],
		});
		expect(executeAsync).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("should run a healthy task once without warning", async () => {
		expect.assertions(4);

		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});
		const warning = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const executeAsync = vi.fn<ExecuteAttempt>().mockResolvedValue(SUCCESS);

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
			.fn<ExecuteAttempt>()
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

		const executeAsync = vi.fn<ExecuteAttempt>().mockResolvedValue(SUCCESS);
		await executeWithRecoveryAsync({ executeAsync, now, timeout: 30_001 });
		await executeWithRecoveryAsync({ executeAsync, now, timeout: 30_001 });
		const [first, second] = executeAsync.mock.calls;

		expect(first![0].claim).toContain(", 1240002, 301");
		expect(first![0].claim).toMatch(
			/local key, startBefore, retention, notClaimed, startExpired = "[\da-f-]{36}"/,
		);
		expect(first![0].claim).not.toContain("__EXECUTION_CLAIM_PARAMETERS__");
		expect(first![0].claim).not.toBe(second![0].claim);
	});

	it("should retain an explicit startup window across both attempts", async () => {
		expect.assertions(2);

		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const executeAsync = vi
			.fn<ExecuteAttempt>()
			.mockRejectedValueOnce(timeoutFailure())
			.mockResolvedValue(SUCCESS);
		await executeWithRecoveryAsync({
			executeAsync,
			now: () => 10_000,
			startupWindowMs: 987_654,
			timeout: 30_000,
		});

		expect(executeAsync.mock.calls[0]![0].claim).toContain(", 997654, 1048");
		expect(executeAsync.mock.calls[1]![0].claim).toBe(executeAsync.mock.calls[0]![0].claim);
	});

	it.for([new Error("Script FAILED"), new Error("HTTP 401"), "transport rejected"])(
		"should propagate a non-poll failure without retry: %s",
		async (failure) => {
			expect.assertions(2);

			const executeAsync = vi.fn<ExecuteAttempt>().mockRejectedValue(failure);

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
		const executeAsync = vi.fn<ExecuteAttempt>().mockRejectedValue(failure);

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
			.fn<ExecuteAttempt>()
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
		const readResultAsync = vi.fn<() => Promise<ScriptResult>>().mockResolvedValue(SUCCESS);
		const failure = new ExecutionTimeoutError(timeoutFailure(), readResultAsync);
		const executeAsync = vi
			.fn<ExecuteAttempt>()
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
		const readResultAsync = vi.fn<() => Promise<ScriptResult>>();
		const failure = new ExecutionTimeoutError(timeoutFailure(), readResultAsync);
		const executeAsync = vi
			.fn<ExecuteAttempt>()
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
		const readResultAsync = vi.fn<() => Promise<ScriptResult>>().mockResolvedValue(SUCCESS);
		const first = new ExecutionTimeoutError(timeoutFailure(), readResultAsync);
		const executeAsync = vi
			.fn<ExecuteAttempt>()
			.mockRejectedValueOnce(first)
			.mockRejectedValue(timeoutFailure());

		await expect(executeWithRecoveryAsync({ executeAsync, timeout: 30_000 })).resolves.toBe(
			SUCCESS,
		);
		expect(readResultAsync).toHaveBeenCalledOnce();
	});

	it("should accept a recovered replacement while the original reader is still pending", async () => {
		expect.assertions(5);

		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const stopped = Promise.withResolvers<void>();
		const originalReader = vi.fn<(signal?: AbortSignal) => Promise<ScriptResult>>(
			async (signal) => {
				try {
					await delayAsync(60_000, undefined, { signal });
					return SUCCESS;
				} finally {
					stopped.resolve();
				}
			},
		);
		const replacementReader = vi.fn<() => Promise<ScriptResult>>().mockResolvedValue(SUCCESS);
		const executeAsync = vi
			.fn<ExecuteAttempt>()
			.mockRejectedValueOnce(new ExecutionTimeoutError(timeoutFailure(), originalReader))
			.mockRejectedValueOnce(new ExecutionTimeoutError(timeoutFailure(), replacementReader));

		await expect(executeWithRecoveryAsync({ executeAsync, timeout: 30_000 })).resolves.toBe(
			SUCCESS,
		);

		await stopped.promise;

		expect(originalReader.mock.calls[0]![0]!.aborted).toBeTrue();
		expect(originalReader).toHaveBeenCalledOnce();
		expect(replacementReader).toHaveBeenCalledOnce();
		expect(
			executeAsync.mock.calls.map(([context]) => context.observationSignal.aborted),
		).toStrictEqual([true, true]);
	});

	it("should retain both native recovery failures with the original execution as cause", async () => {
		expect.assertions(2);

		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const originalReadFailure = new Error("original read failed");
		const replacementReadFailure = new Error("replacement read failed");
		const original = new ExecutionTimeoutError(timeoutFailure(), async () => {
			throw originalReadFailure;
		});
		const replacement = new ExecutionTimeoutError(timeoutFailure(), async () => {
			throw replacementReadFailure;
		});
		const executeAsync = vi
			.fn<ExecuteAttempt>()
			.mockRejectedValueOnce(original)
			.mockRejectedValueOnce(replacement);

		await expect(
			executeWithRecoveryAsync({ executeAsync, timeout: 30_000 }),
		).rejects.toMatchObject({
			cause: original,
			errors: [original, replacement, originalReadFailure, replacementReadFailure],
		});
		expect(
			executeAsync.mock.calls.map(([context]) => context.observationSignal.aborted),
		).toStrictEqual([true, true]);
	});

	it("should never treat a declined original as test results", async () => {
		expect.assertions(2);

		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const first = new ExecutionTimeoutError(timeoutFailure(), async () => DECLINED);
		const executeAsync = vi
			.fn<ExecuteAttempt>()
			.mockRejectedValueOnce(first)
			.mockResolvedValue(DECLINED);

		await expect(executeWithRecoveryAsync({ executeAsync, timeout: 30_000 })).rejects.toThrow(
			"refusing to run tests twice",
		);
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
			.fn<ExecuteAttempt>()
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

		const executeAsync = vi.fn<ExecuteAttempt>().mockResolvedValue(DECLINED);

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
		const executeAsync = vi.fn<ExecuteAttempt>().mockResolvedValue(result);

		await expect(executeWithRecoveryAsync({ executeAsync, timeout: 30_000 })).resolves.toBe(
			result,
		);
	});

	it("should diagnose an expired startup window without retrying", async () => {
		expect.assertions(2);

		const executeAsync = vi
			.fn<ExecuteAttempt>()
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
			.fn<ExecuteAttempt>()
			.mockRejectedValueOnce(first)
			.mockRejectedValue(second);

		await expect(
			executeWithRecoveryAsync({ executeAsync, timeout: 30_000 }),
		).rejects.toMatchObject({ cause: first, errors: [first, second, readFailure] });
	});

	it("should use the supplied claim identity and clock", async () => {
		expect.assertions(1);

		const executeAsync = vi.fn<ExecuteAttempt>().mockResolvedValue(SUCCESS);
		await executeWithRecoveryAsync({
			createKey: () => "execution-key",
			executeAsync,
			now: () => 1000,
			timeout: 30_000,
		});

		expect(executeAsync.mock.calls[0]![0].claim).toContain(
			'"execution-key", 241000, 300, "__JEST_ROBLOX_EXECUTION_NOT_CLAIMED__", "__JEST_ROBLOX_EXECUTION_START_EXPIRED__"',
		);
	});
});
