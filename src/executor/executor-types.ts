import type { AttributionResult } from "../attribution/attribution.ts";
import type { ProjectJob } from "../backends/interface.ts";
import type { ResolvedConfig } from "../config/resolved-config.ts";
import type { RawCoverageData } from "../coverage-data/coverage-types.ts";
import type { SourceMapper } from "../source-mapper/index.ts";
import type { JestResult } from "../types/jest-result-types.ts";
import type { TimingResult } from "../types/timing-types.ts";

/** A backend job with the resolved config the executor built it from. */
export interface ConfiguredJob extends ProjectJob {
	/** Resolved config of the project. */
	config: ResolvedConfig;
}

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
	/** `"batch"` when `gameOutput` holds the whole run's capture. */
	gameOutputScope?: "batch" | undefined;
	/** The parsed Jest result. */
	result: JestResult;
	/** Count of snapshot writes that failed. */
	snapshotWriteFailures?: number | undefined;
	/** Maps Luau locations back to TypeScript source. */
	sourceMapper?: SourceMapper | undefined;
	/** Timing breakdown of the run. */
	timing: TimingResult;
}
