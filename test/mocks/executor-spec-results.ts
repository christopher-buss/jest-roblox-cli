import type { JestResult, TestCaseResult, TestFileResult } from "#src/types/jest-result-types.ts";

export function createPassingResult(): JestResult {
	return suiteResult([testSpecFile(passed("Test", "also passes", 5))]);
}

export function createFailingResult(): JestResult {
	return suiteResult([failingTestSpecFile()]);
}

export function createMixedResult(): JestResult {
	return suiteResult([
		fileResult("src/utils.spec.ts", [passed("Utils", "adds", 10), passed("Utils", "subs", 5)]),
		failingTestSpecFile(),
	]);
}

function passed(suite: string, title: string, duration: number): TestCaseResult {
	return {
		ancestorTitles: [suite],
		duration,
		failureMessages: [],
		fullName: `${suite} ${title}`,
		status: "passed",
		title,
	};
}

function countStatus(
	cases: ReadonlyArray<TestCaseResult>,
	status: TestCaseResult["status"],
): number {
	return cases.filter((testCase) => testCase.status === status).length;
}

function suiteResult(files: Array<TestFileResult>): JestResult {
	const cases = files.flatMap((file) => file.testResults);
	const numberFailedTests = countStatus(cases, "failed");
	return {
		numFailedTests: numberFailedTests,
		numPassedTests: countStatus(cases, "passed"),
		numPendingTests: 0,
		numTotalTests: cases.length,
		startTime: Date.now(),
		success: numberFailedTests === 0,
		testResults: files,
	};
}

function fileResult(testFilePath: string, cases: Array<TestCaseResult>): TestFileResult {
	return {
		numFailingTests: countStatus(cases, "failed"),
		numPassingTests: countStatus(cases, "passed"),
		numPendingTests: 0,
		testFilePath,
		testResults: cases,
	};
}

function testSpecFile(second: TestCaseResult): TestFileResult {
	return fileResult("src/test.spec.ts", [passed("Test", "passes", 10), second]);
}

function failed(suite: string, title: string, duration: number, message: string): TestCaseResult {
	return { ...passed(suite, title, duration), failureMessages: [message], status: "failed" };
}

function failingTestSpecFile(): TestFileResult {
	return testSpecFile(failed("Test", "fails", 5, "Expected true, got false"));
}
