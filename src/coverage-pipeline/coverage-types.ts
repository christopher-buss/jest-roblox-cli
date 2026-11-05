/**
 * Raw hit counts for a single file, keyed by statement/function index.
 */
export interface RawFileCoverage {
	/** Branch arm hit counts by branch index. */
	b?: Record<string, Array<number>>;
	/** Function hit counts by function index. */
	f?: Record<string, number>;
	/** Statement hit counts by statement index. */
	s: Record<string, number>;
}

/**
 * Raw coverage data for all files, keyed by original Luau-relative path.
 */
export type RawCoverageData = Record<string, RawFileCoverage>;

/**
 * One Jest test case's coverage delta, as the Luau runner harvested it: the
 * statements (keyed by original Luau-relative path) whose hit count rose while
 * that test ran. Produced by the parser from the run envelope, consumed by the
 * per-test attribution harvester.
 */
export interface PerTestCoverageEntry {
	/** Statement indices whose hit count rose, by Luau-relative path. */
	delta: Record<string, { s: Array<number> }>;
	/** Test case identifier within its file. */
	testCaseId: string;
	/** Path of the test file as the runner reported it. */
	testFilePath: string;
}
