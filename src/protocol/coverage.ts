import { type Type, type } from "arktype";

/** The `_G` key instrumented code counts its hits under. */
export const COVERAGE_GLOBAL = "__jest_roblox_cov";

/** A per-file counter bucket: branches, functions or statements. */
export type CoverageBucket = "b" | "f" | "s";

/** One test's attribution record, as the runner reports it. */
export interface PerTestCoverageEntry {
	/** Statement indices whose hit count rose, by Luau-relative path. */
	delta: Record<string, { s: Array<number> }>;
	/** Test case identifier within its file. */
	testCaseId: string;
	/** Path of the test file as the runner reported it. */
	testFilePath: string;
}

export const perTestCoverageSchema: Type<Array<PerTestCoverageEntry>> = type({
	delta: type({ "[string]": { s: "number[]" } }),
	testCaseId: "string",
	testFilePath: "string",
}).array();
