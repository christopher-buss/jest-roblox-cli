export type TestStatus = "disabled" | "failed" | "passed" | "pending" | "skipped" | "todo";

export interface TestCaseResult {
	ancestorTitles: Array<string>;
	duration?: number;
	failureMessages: Array<string>;
	fullName: string;
	location?: { column: number; line: number };
	numPassingAsserts?: number;
	retryReasons?: Array<string>;
	status: TestStatus;
	title: string;
}

export interface TestFileResult {
	failureMessage?: string;
	numFailingTests: number;
	numPassingTests: number;
	numPendingTests: number;
	testFilePath: string;
	testResults: Array<TestCaseResult>;
}

export interface SnapshotSummary {
	added: number;
	matched: number;
	total: number;
	unmatched: number;
	updated: number;
}

export interface JestResult {
	numFailedTests: number;
	numPassedTests: number;
	numPendingTests: number;
	numTodoTests?: number;
	numTotalTests: number;
	snapshot?: SnapshotSummary;
	startTime: number;
	success: boolean;
	testResults: Array<TestFileResult>;
}

export function hasExecError(file: TestFileResult): boolean {
	return (
		file.failureMessage !== undefined &&
		file.failureMessage !== "" &&
		file.testResults.length === 0
	);
}
