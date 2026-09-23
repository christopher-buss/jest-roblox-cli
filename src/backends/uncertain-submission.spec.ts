import { ApiError, NetworkError, RequestAbortedError } from "@bedrock-rbx/ocale";
import { TaskSubmitError } from "@isentinel/roblox-runner";

import { describe, expect, it } from "vitest";

import { isUncertainTaskSubmit } from "./uncertain-submission.ts";

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

	it("should not rescue a create the caller cancelled", () => {
		expect.assertions(1);

		const aborted = new RequestAbortedError("Request was aborted", { reason: "superseded" });

		expect(isUncertainTaskSubmit(new TaskSubmitError(aborted))).toBeFalse();
	});

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
});
