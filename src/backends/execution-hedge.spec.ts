import { PollTimeoutError } from "@bedrock-rbx/ocale";
import type { ScriptResult } from "@isentinel/roblox-runner";

import { describe, expect, it, vi } from "vitest";

import {
	EXECUTION_NOT_CLAIMED,
	EXECUTION_START_EXPIRED,
} from "#test/mocks/luau-execution-claim.ts";
import {
	type ObservedAttempt,
	type ReadResult,
	requireClaim,
	resolveHedgeAsync,
	settleAsync,
} from "./execution-hedge.ts";

const SUCCESS: ScriptResult = { durationMs: 12, outputs: ["test results"] };
const DECLINED: ScriptResult = { durationMs: 1, outputs: [EXECUTION_NOT_CLAIMED] };

function timeoutFailure(message: string): Error {
	return new Error(message, {
		cause: new PollTimeoutError("Still PROCESSING", { timeoutMs: 75_000 }),
	});
}

function attempt(promise: Promise<ScriptResult>): ObservedAttempt & { cancel: () => void } {
	return { cancel: vi.fn<() => void>(), outcome: settleAsync(promise) };
}

function hedge() {
	const original = Promise.withResolvers<ScriptResult>();
	const replacement = Promise.withResolvers<ScriptResult>();
	const replacementAttempt = attempt(replacement.promise);
	const resolved = resolveHedgeAsync({
		original: attempt(original.promise),
		readResultAsync: vi.fn<ReadResult>(),
		replacement: replacementAttempt,
	});
	return { original, replacement, replacementAttempt, resolved };
}

describe(resolveHedgeAsync, () => {
	it("should use the hedge when the original declines first", async () => {
		expect.assertions(2);

		const { original, replacement, replacementAttempt, resolved } = hedge();
		original.resolve(DECLINED);
		replacement.resolve(SUCCESS);

		await expect(resolved).resolves.toBe(SUCCESS);
		expect(replacementAttempt.cancel).toHaveBeenCalledOnce();
	});

	it("should use the original when a rejected hedge finishes first", async () => {
		expect.assertions(1);

		const { original, replacement, resolved } = hedge();
		replacement.reject(timeoutFailure("Hedged execution timed out"));
		original.resolve(SUCCESS);

		await expect(resolved).resolves.toBe(SUCCESS);
	});

	it("should preserve both failures when the original and hedge stall", async () => {
		expect.assertions(1);

		const first = timeoutFailure("Original execution timed out");
		const second = timeoutFailure("Hedged execution timed out");
		const { original, replacement, resolved } = hedge();
		original.reject(first);
		replacement.reject(second);

		await expect(resolved).rejects.toMatchObject({ cause: first, errors: [first, second] });
	});

	it("should preserve attempt order when the hedge fails first", async () => {
		expect.assertions(1);

		const first = new Error("original stalled");
		const second = new Error("hedge stalled");
		const { original, replacement, resolved } = hedge();
		replacement.reject(second);
		original.reject(first);

		await expect(resolved).rejects.toMatchObject({ cause: first, errors: [first, second] });
	});

	it("should fail when neither hedged task claims execution", async () => {
		expect.assertions(1);

		const { original, replacement, resolved } = hedge();
		replacement.resolve(DECLINED);
		original.resolve(DECLINED);

		await expect(resolved).rejects.toThrow("refusing to run tests twice");
	});
});

describe(requireClaim, () => {
	it("should pass a claimed result through", () => {
		expect.assertions(1);

		expect(requireClaim(SUCCESS)).toBe(SUCCESS);
	});

	it("should diagnose an expired start window", () => {
		expect.assertions(1);

		expect(() => requireClaim({ durationMs: 0, outputs: [EXECUTION_START_EXPIRED] })).toThrow(
			"start window expired",
		);
	});
});
