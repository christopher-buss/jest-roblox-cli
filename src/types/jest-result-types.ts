/** The outcome Jest reports for one test. */
export type TestStatus = "disabled" | "failed" | "passed" | "pending" | "skipped" | "todo";

/** Jest's result for one test. */
export interface TestCaseResult {
	/** Titles of the enclosing `describe` blocks, outermost first. */
	ancestorTitles: Array<string>;
	/** Run time of the test, in milliseconds. */
	duration?: number | undefined;
	/** One message per failed assertion or error. */
	failureMessages: Array<string>;
	/** The ancestor titles and the test title, joined by spaces. */
	fullName: string;
	/**
	 * Gaps this test raised, by `Class.Member`. Set only by a backend that
	 * reports gaps.
	 */
	gaps?: Record<string, number> | undefined;
	/** Where the test is declared in its file. */
	location?: {
		/** The declaration's column. */
		column: number;
		/** The declaration's line. */
		line: number;
	};
	/** Count of assertions that passed. */
	numPassingAsserts?: number | undefined;
	/** The failure message of each retried attempt. */
	retryReasons?: Array<string> | undefined;
	/** The test's outcome. */
	status: TestStatus;
	/** The test's own title, without ancestors. */
	title: string;
}

/** Jest's result for one test file. */
export interface TestFileResult {
	/** The file's failure text, or the error that stopped the suite. */
	failureMessage?: string | undefined;
	/**
	 * Gaps raised in this file outside every test, by `Class.Member`. Each one
	 * blocks every test in the file.
	 */
	gaps?: Record<string, number> | undefined;
	/** Count of failed tests in the file. */
	numFailingTests: number;
	/** Count of passed tests in the file. */
	numPassingTests: number;
	/** Count of pending tests in the file. */
	numPendingTests: number;
	/** The path of the test file. */
	testFilePath: string;
	/** The result of each test in the file. */
	testResults: Array<TestCaseResult>;
	/**
	 * The runner abandoned this project at its `projectTimeout` rather than
	 * waiting for it. Only ever set on the synthetic file an exec error is
	 * reported through — a real test file result comes from Jest, which
	 * returned nothing for a run that never finished.
	 */
	timedOut?: boolean | undefined;
}

/** A file result whose suite failed before any test ran. */
export type ExecErrorTestFileResult = TestFileResult & { failureMessage: string };

/** Jest's snapshot counts for a run. */
export interface SnapshotSummary {
	/** Snapshots written for the first time. */
	added: number;
	/** True when the run was allowed to rewrite snapshots. */
	didUpdate?: boolean | undefined;
	/** Obsolete snapshot files deleted. */
	filesRemoved?: number | undefined;
	/** Snapshots that matched. */
	matched: number;
	/** All snapshots checked. */
	total: number;
	/** Stored snapshots no test checked. */
	unchecked?: number | undefined;
	/** Snapshots that did not match. */
	unmatched: number;
	/** Snapshots rewritten to the new value. */
	updated: number;
}

/** Jest's aggregated result for a run. */
export interface JestResult {
	/** Count of failed tests. */
	numFailedTests: number;
	/** Count of passed tests. */
	numPassedTests: number;
	/** Count of pending tests. */
	numPendingTests: number;
	/** Count of `todo` tests. */
	numTodoTests?: number | undefined;
	/** Count of all tests. */
	numTotalTests: number;
	/** The run's snapshot counts. */
	snapshot?: SnapshotSummary | undefined;
	/** When the run started, as epoch milliseconds. */
	startTime: number;
	/** True when no test or suite failed. */
	success: boolean;
	/** The result of each test file. */
	testResults: Array<TestFileResult>;
}
