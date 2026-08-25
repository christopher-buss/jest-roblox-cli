import type { ResolvedConfig } from "../config/schema.ts";
import type { AttributionResult } from "../coverage-pipeline/attribution.ts";
import type { RawCoverageData } from "../coverage-pipeline/types.ts";
import type { SourceMapper } from "../source-mapper/index.ts";
import type { JestResult } from "../types/jest-result.ts";
import type { TimingResult } from "../types/timing.ts";

export interface ExecuteResult {
	attribution?: AttributionResult | undefined;
	coverageData?: RawCoverageData | undefined;
	exitCode: number;
	gameOutput?: string | undefined;
	output: string;
	result: JestResult;
	snapshotWriteFailures?: number | undefined;
	sourceMapper?: SourceMapper | undefined;
	timing: TimingResult;
}

export interface FormatOutputOptions {
	config: ResolvedConfig;
	result: JestResult;
	snapshotWriteFailures?: number | undefined;
	sourceMapper?: SourceMapper | undefined;
	timing: TimingResult;
	/** Type errors from the parallel type pass, when one ran. */
	typeErrorCount?: number | undefined;
	version: string;
}
