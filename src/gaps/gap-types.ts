/** How often a run raised `NotEmulated` for each member, by `Class.Member`. */
export type GapTally = Record<string, number>;

/** Every attribution a run set with its gaps, keyed by DataModel path. */
export interface GapRecord {
	/** Gaps raised inside each attributed test file or test. */
	attributed: Array<AttributedGaps>;
	/** Gaps raised outside every test file. */
	unattributed: GapTally;
}

type AttributedGaps =
	| { file: string; gaps: GapTally; position: number; test: string }
	| { file: string; gaps: GapTally; position?: undefined; test?: undefined };
