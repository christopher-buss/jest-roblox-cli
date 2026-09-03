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
	/**
	 * The runner abandoned this project at its `projectTimeout` rather than
	 * waiting for it. Only ever set on the synthetic file an exec error is
	 * reported through — a real test file result comes from Jest, which
	 * returned nothing for a run that never finished.
	 */
	timedOut?: boolean | undefined;
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

/**
 * The synthetic path a suite that never ran is filed under. Jest names a file
 * result by the file it ran; a failure that happened before any file did has no
 * such name, so this stands in for one.
 */
export const EXEC_ERROR_FILE_PATH = "<exec-error>";

/**
 * How a suite that never ran is described, in the one wording every formatter
 * says it in. Both readings are failures; only a timeout names a budget the
 * reader can raise, so the reports keep them apart.
 */
export function execErrorReason(file: TestFileResult): "failed to run" | "timed out" {
	return file.timedOut === true ? "timed out" : "failed to run";
}

/** The heading every formatter titles a suite that never ran with. */
export function execErrorTitle(file: TestFileResult): string {
	return `Test suite ${execErrorReason(file)}`;
}

export function hasExecError(file: TestFileResult): file is ExecErrorTestFileResult {
	return (
		file.failureMessage !== undefined &&
		file.failureMessage !== "" &&
		file.testResults.length === 0
	);
}
