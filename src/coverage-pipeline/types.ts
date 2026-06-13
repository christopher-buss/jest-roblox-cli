/**
 * Raw hit counts for a single file, keyed by statement/function index.
 */
export interface RawFileCoverage {
	b?: Record<string, Array<number>>;
	f?: Record<string, number>;
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
	delta: Record<string, { s: Array<number> }>;
	testCaseId: string;
	testFilePath: string;
}
