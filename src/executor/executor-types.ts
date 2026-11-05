import type { ResolvedConfig } from "../config/schema.ts";
import type { AttributionResult } from "../coverage-pipeline/attribution.ts";
import type { RawCoverageData } from "../coverage-pipeline/coverage-types.ts";
import type { SourceMapper } from "../source-mapper/index.ts";
import type { JestResult } from "../types/jest-result-types.ts";
import type { TimingResult } from "../types/timing-types.ts";

/** The outcome of one executed project. */
export interface ExecuteResult {
	/** Per-test coverage attribution, when per-test coverage was collected. */
	attribution?: AttributionResult | undefined;
	/** Raw coverage hits, when coverage was collected. */
	coverageData?: RawCoverageData | undefined;
	/** Process exit code for this project. */
	exitCode: number;
	/** Captured Game Output, when any. */
	gameOutput?: string | undefined;
	/**
	 * `"batch"` when `gameOutput` holds the whole run's capture rather than
	 * this project's own. Set by an in-session parallel Studio run, where
	 * `LogService` messages carry no project identity.
	 */
	gameOutputScope?: "batch" | undefined;
	/** Formatted output; empty when formatting is deferred. */
	output: string;
	/** The parsed Jest result. */
	result: JestResult;
	/** Count of snapshot writes that failed. */
	snapshotWriteFailures?: number | undefined;
	/** Maps Luau locations back to TypeScript source. */
	sourceMapper?: SourceMapper | undefined;
	/** Timing breakdown of the run. */
	timing: TimingResult;
}

/** Inputs for `formatExecuteOutput`. */
export interface FormatOutputOptions {
	/** Resolved config that selects the formatter. */
	config: ResolvedConfig;
	/** The Jest result to format. */
	result: JestResult;
	/** Count of snapshot writes that failed. */
	snapshotWriteFailures?: number | undefined;
	/** Maps Luau locations back to TypeScript source. */
	sourceMapper?: SourceMapper | undefined;
	/** Timing breakdown of the run. */
	timing: TimingResult;
	/** Type errors from the parallel type pass, when one ran. */
	typeErrorCount?: number | undefined;
	/** CLI version shown in the output. */
	version: string;
}
