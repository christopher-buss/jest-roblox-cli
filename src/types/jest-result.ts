export type TestStatus = "disabled" | "failed" | "passed" | "pending" | "skipped" | "todo";

export interface TestCaseResult {
	ancestorTitles: Array<string>;
	duration?: number | undefined;
	failureMessages: Array<string>;
	fullName: string;
	location?: { column: number; line: number };
	numPassingAsserts?: number | undefined;
	retryReasons?: Array<string> | undefined;
	status: TestStatus;
	title: string;
}

export interface TestFileResult {
	failureMessage?: string | undefined;
	numFailingTests: number;
	numPassingTests: number;
	numPendingTests: number;
	testFilePath: string;
	testResults: Array<TestCaseResult>;
}

export type ExecErrorTestFileResult = TestFileResult & { failureMessage: string };

export interface SnapshotSummary {
	added: number;
	didUpdate?: boolean | undefined;
	filesRemoved?: number | undefined;
	matched: number;
	total: number;
	unchecked?: number | undefined;
	unmatched: number;
	updated: number;
}

export interface JestResult {
	numFailedTests: number;
	numPassedTests: number;
	numPendingTests: number;
	numTodoTests?: number | undefined;
	numTotalTests: number;
	snapshot?: SnapshotSummary | undefined;
	startTime: number;
	success: boolean;
	testResults: Array<TestFileResult>;
}

export function hasExecError(file: TestFileResult): file is ExecErrorTestFileResult {
	return (
		file.failureMessage !== undefined &&
		file.failureMessage !== "" &&
		file.testResults.length === 0
	);
}
