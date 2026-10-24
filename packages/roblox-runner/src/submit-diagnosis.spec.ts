import {
	NetworkError,
	RateLimitError,
	RateLimitWaitRefusedError,
	RetryDelayExceededError,
} from "@bedrock-rbx/ocale";

import { describe, expect, it, vi } from "vitest";

import { isEdgeRateLimited, refuseUnfitWait, toSubmitError } from "./submit-diagnosis.ts";

const TASK = { apiKey: "secret", placeVersion: 4, timeoutSeconds: 6 };

describe(toSubmitError, () => {
	it("should preserve a submission failure's original cause", () => {
		expect.assertions(3);

		const cause = new NetworkError("offline");
		const error = toSubmitError(cause, TASK);

		expect(error.name).toBe("TaskSubmitError");
		expect(error.message).toBe("offline");
		expect(error.cause).toBe(cause);
	});

	it("should include lockout unlock, server code and redacted headers", () => {
		expect.assertions(2);

		vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 0, 1));
		const cause = new RateLimitError("quota", {
			code: "RESOURCE_EXHAUSTED",
			details: { code: "QUOTA", message: "secret blocked" },
			responseHeaders: { diagnostic: "secret" },
			retryAfterSeconds: 75,
		});
		const error = toSubmitError(cause, TASK);

		expect(error.name).toBe("TaskQuotaError");
		expect(error.message).toBe(
			"QUOTA: [REDACTED] blocked\n  Roblox refused task creates for longer than its per-minute limit; this account can create tasks again at 2026-01-01T00:01:15Z.\n  code: RESOURCE_EXHAUSTED\n  diagnostic: [REDACTED]",
		);
	});

	it.for([
		{ details: undefined, retryAfterSeconds: 60 },
		{ details: { errors: [] }, retryAfterSeconds: 75 },
	])("should omit account lockout claims for minute limits and edge refusals: %j", (options) => {
		expect.assertions(1);

		expect(toSubmitError(new RateLimitError("quota", options), TASK).message).toBe("quota");
	});

	it.for([
		(quota: RateLimitError) => {
			return new RetryDelayExceededError("too long", {
				cause: quota,
				deadlineMs: 10,
				remainingMs: 1,
				retryAfterMs: 2000,
			});
		},
		(quota: RateLimitError) => new RateLimitWaitRefusedError("too long", { cause: quota }),
	])("should retain a refusal that wraps the quota cause", (makeCause) => {
		expect.assertions(2);

		const quota = new RateLimitError("quota", { retryAfterSeconds: 2 });
		const cause = makeCause(quota);
		const error = toSubmitError(cause, TASK);

		expect(error.name).toBe("TaskQuotaError");
		expect(error.cause).toBe(cause);
	});
});

describe("edge admission policy", () => {
	it.for([
		{ error: new NetworkError("offline"), expected: false },
		{
			error: new RateLimitError("edge", { details: { errors: [] }, retryAfterSeconds: 1 }),
			expected: true,
		},
		{
			error: new RateLimitError("server", {
				details: { code: "RESOURCE_EXHAUSTED" },
				retryAfterSeconds: 1,
			}),
			expected: false,
		},
	])(
		"should distinguish the edge envelope from server and network failures: $expected",
		({ error, expected }) => {
			expect.assertions(1);

			expect(isEdgeRateLimited({ err: error, success: false })).toBe(expected);
		},
	);

	it("should permit a wait that ends exactly at the deadline", () => {
		expect.assertions(1);

		vi.spyOn(Date, "now").mockReturnValue(1000);

		expect(
			refuseUnfitWait({ cause: new NetworkError("retry"), deadlineMs: 3000, waitMs: 2000 }),
		).toBeUndefined();
	});

	it("should preserve the refused wait, remaining budget and original cause", () => {
		expect.assertions(2);

		vi.spyOn(Date, "now").mockReturnValue(1000);
		const cause = new NetworkError("retry");
		const error = refuseUnfitWait({ cause, deadlineMs: 2999, waitMs: 2999 });

		expect(error).toMatchObject({
			cause,
			deadlineMs: 2999,
			remainingMs: 1999,
			retryAfterMs: 2999,
		});
		expect(error!.message).toBe(
			"Open Cloud asked the task create to wait before retrying, past the task deadline: would wait 3s; 2s remain",
		);
	});

	it("should clamp an elapsed deadline to no remaining time", () => {
		expect.assertions(1);

		vi.spyOn(Date, "now").mockReturnValue(5000);

		expect(
			refuseUnfitWait({ cause: new NetworkError("retry"), deadlineMs: 1000, waitMs: 1000 }),
		).toMatchObject({ remainingMs: 0 });
	});
});

describe("wrapped transport failure", () => {
	it("should keep a transport failure distinct from SDK quota-wait refusal", () => {
		expect.assertions(1);

		const quota = new RateLimitError("quota", { retryAfterSeconds: 5 });
		const error = new NetworkError("connection lost", { cause: quota });

		expect(
			toSubmitError(error, { apiKey: "key", placeVersion: 1, timeoutSeconds: 30 }),
		).toMatchObject({ name: "TaskSubmitError", cause: error });
	});
});
