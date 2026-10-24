import { NetworkError } from "@bedrock-rbx/ocale";

import { describe, expect, it } from "vitest";

import { TaskSubmitError } from "./task-submit-error.ts";

describe(TaskSubmitError, () => {
	it("should identify submission failures and preserve their cause", () => {
		expect.assertions(3);

		const cause = new NetworkError("offline");
		const error = new TaskSubmitError(cause);

		expect(error.name).toBe("TaskSubmitError");
		expect(error.message).toBe("offline");
		expect(error.cause).toBe(cause);
	});

	it("should accept a more specific diagnostic message", () => {
		expect.assertions(1);

		const error = new TaskSubmitError(new NetworkError("offline"), "refused");

		expect(error.message).toBe("refused");
	});
});
