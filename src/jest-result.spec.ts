import { fromPartial } from "@total-typescript/shoehorn";

import { describe, expect, it } from "vitest";

import type { TestFileResult } from "./types/jest-result.ts";
import { hasExecError } from "./types/jest-result.ts";

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
