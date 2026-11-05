import { fromPartial } from "@total-typescript/shoehorn";

import { describe, expect, it } from "vitest";

import { execErrorReason, execErrorTitle, hasExecError } from "./exec-error-file.ts";
import type { TestFileResult } from "./jest-result-types.ts";

describe(hasExecError, () => {
	it.for([
		{ failureMessage: undefined, testResults: [] },
		{ failureMessage: "", testResults: [] },
		{ failureMessage: "test suite failed", testResults: [{}] },
	])("should reject a non-execution error: %j", (file) => {
		expect.assertions(1);

		expect(hasExecError(fromPartial<TestFileResult>(file))).toBeFalse();
	});

	it("should identify a file-level execution error", () => {
		expect.assertions(1);

		expect(
			hasExecError(
				fromPartial<TestFileResult>({
					failureMessage: "test suite failed",
					testResults: [],
				}),
			),
		).toBeTrue();
	});
});

describe(execErrorTitle, () => {
	it("should title a suite that failed to run", () => {
		expect.assertions(1);

		expect(execErrorTitle(fromPartial<TestFileResult>({}))).toBe("Test suite failed to run");
	});

	it("should title a suite that timed out", () => {
		expect.assertions(1);

		expect(execErrorTitle(fromPartial<TestFileResult>({ timedOut: true }))).toBe(
			"Test suite timed out",
		);
	});
});

describe(execErrorReason, () => {
	it("should not read a false timeout flag as a timeout", () => {
		expect.assertions(1);

		expect(execErrorReason(fromPartial<TestFileResult>({ timedOut: false }))).toBe(
			"failed to run",
		);
	});
});
