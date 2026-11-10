/** Raw hit counts for one file. */
export interface RawFileCoverage {
	/** Branch arm hit counts by branch index. */
	b?: Record<string, Array<number>>;
	/** Function hit counts by function index. */
	f?: Record<string, number>;
	/** Statement hit counts by statement index. */
	s: Record<string, number>;
}

/** Raw coverage for all files, keyed by Luau-relative path. */
export type RawCoverageData = Record<string, RawFileCoverage>;
