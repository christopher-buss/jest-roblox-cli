import { ApiError, NetworkError } from "@bedrock-rbx/ocale";
import { ExecutionTimeoutError, TaskSubmitError } from "@isentinel/roblox-runner";

import { describe, expect, it } from "vitest";

import {
	isUncertainTaskSubmit,
	UncertainSubmissionError,
	withResultReader,
} from "./uncertain-submission.ts";

describe(isUncertainTaskSubmit, () => {
	it.for([
		{ cause: new DOMException("timed out", "TimeoutError"), expected: true },
		{ cause: new DOMException("canceled", "AbortError"), expected: false },
		{ cause: new Error("transport failure"), expected: false },
	])(
		"should classify the SDK request timeout without retrying cancellation",
		({ cause, expected }) => {
			expect.assertions(1);

			expect(
				isUncertainTaskSubmit(
					new TaskSubmitError(new NetworkError("request failed", { cause })),
				),
			).toBe(expected);
		},
	);

	it.for([500, 502, 503, 504])("should retain an ambiguous create HTTP %i", (statusCode) => {
		expect.assertions(1);

		expect(
			isUncertainTaskSubmit(new TaskSubmitError(new ApiError("failed", { statusCode }))),
		).toBeTrue();
	});

	it.for([400, 401, 403, 429, 499, 501, 599, 600])(
		"should not rescue a refused create HTTP %i",
		(statusCode) => {
			expect.assertions(1);

			expect(
				isUncertainTaskSubmit(new TaskSubmitError(new ApiError("failed", { statusCode }))),
			).toBeFalse();
		},
	);

	it("should distinguish uncertain transport creates from GET and unknown transport failures", () => {
		expect.assertions(3);

		const transport = new NetworkError("reset", {
			cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }),
		});

		expect(isUncertainTaskSubmit(new TaskSubmitError(transport))).toBeTrue();
		expect(isUncertainTaskSubmit(new ApiError("GET failed", { statusCode: 500 }))).toBeFalse();
		expect(isUncertainTaskSubmit(new TaskSubmitError(new NetworkError("unknown")))).toBeFalse();
	});

	it.for([
		new ExecutionTimeoutError(new Error("uncertain"), async () => {
			return { durationMs: 0, outputs: ["old"] };
		}),
		new UncertainSubmissionError(new Error("uncertain"), async () => {
			return { durationMs: 0, outputs: ["old"] };
		}),
	])("should preserve the recovery kind and replace its reader", async (cause) => {
		expect.assertions(3);

		const error = withResultReader(cause, async () => {
			return {
				durationMs: 1,
				outputs: ["new"],
			};
		});

		expect(error.constructor).toBe(cause.constructor);
		expect(error.message).toBe(cause.message);
		await expect(error.readResultAsync()).resolves.toStrictEqual({
			durationMs: 1,
			outputs: ["new"],
		});
	});
});
