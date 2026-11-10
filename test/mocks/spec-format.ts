import type { JestResult, TestCaseResult } from "#src/types/jest-result-types.ts";
import { createTestCase } from "#test/mocks/format-results.ts";

export function createSingleFileResult(overrides: Partial<JestResult> = {}): JestResult {
	return {
		numFailedTests: 0,
		numPassedTests: 1,
		numPendingTests: 0,
		numTotalTests: 1,
		startTime: 0,
		success: true,
		testResults: [
			{
				numFailingTests: 0,
				numPassingTests: 1,
				numPendingTests: 0,
				testFilePath: "src/example.spec.ts",
				testResults: [createTestCase()],
			},
		],
		...overrides,
	};
}

export function failingFileResult(testFilePath: string, tests: Array<TestCaseResult>): JestResult {
	return createSingleFileResult({
		numFailedTests: tests.length,
		numPassedTests: 0,
		numTotalTests: tests.length,
		success: false,
		testResults: [
			{
				numFailingTests: tests.length,
				numPassingTests: 0,
				numPendingTests: 0,
				testFilePath,
				testResults: tests,
			},
		],
	});
}
