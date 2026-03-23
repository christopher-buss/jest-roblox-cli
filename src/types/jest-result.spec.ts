import { describe, expect, it } from "vitest";

import { hasExecError, type TestFileResult } from "./jest-result.ts";

function createFileResult(overrides: Partial<TestFileResult> = {}): TestFileResult {
	return {
		numFailingTests: 0,
		numPassingTests: 0,
		numPendingTests: 0,
		testFilePath: "test.spec.ts",
		testResults: [],
		...overrides,
	};
}

describe(hasExecError, () => {
	it("should return true when failureMessage is present and testResults is empty", () => {
		expect.assertions(1);

		const file = createFileResult({
			failureMessage: "Require-by-string is not enabled",
		});

		expect(hasExecError(file)).toBeTrue();
	});

	it("should return false when failureMessage is undefined", () => {
		expect.assertions(1);

		const file = createFileResult();

		expect(hasExecError(file)).toBeFalse();
	});

	it("should return false when failureMessage is empty string", () => {
		expect.assertions(1);

		const file = createFileResult({ failureMessage: "" });

		expect(hasExecError(file)).toBeFalse();
	});

	it("should return false when testResults is non-empty", () => {
		expect.assertions(1);

		const file = createFileResult({
			failureMessage: "some error",
			testResults: [
				{
					ancestorTitles: [],
					duration: 10,
					failureMessages: [],
					fullName: "test",
					status: "passed",
					title: "test",
				},
			],
		});

		expect(hasExecError(file)).toBeFalse();
	});
});
