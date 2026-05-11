import type { CliOptions, ResolvedConfig } from "../config/schema.ts";
import type { MappedCoverageResult } from "../coverage/mapper.ts";
import type { ExecuteResult } from "../executor.ts";
import type { SourceMapper } from "../source-mapper/index.ts";
import type { JestResult } from "../types/jest-result.ts";

export type RunMode = "multi" | "single" | "workspace";

export interface ProjectResult {
	displayColor?: string;
	displayName: string;
	result: ExecuteResult;
}

export interface MultiProjectMerged {
	coverageData?: ExecuteResult["coverageData"];
	sourceMapper?: SourceMapper;
}

export interface SingleRunResult {
	mode: "single";
	preCoverageMs: number;
	runtimeResult?: ExecuteResult;
	typecheckResult?: JestResult;
	validationExitCode?: 2;
}

export interface MultiRunResult {
	collectCoverageFrom?: Array<string>;
	merged: MultiProjectMerged;
	mode: "multi";
	preCoverageMs: number;
	projectResults: Array<ProjectResult>;
	typecheckResult?: JestResult;
	validationExitCode?: 2;
	validationMessage?: string;
}

export interface WorkspaceRunResult {
	/**
	 * Pre-aggregated TS-coord coverage merged from every package's
	 * `coverageData + coverageManifest`. Skips the single-package
	 * `loadCoverageManifest(rootDir)` path entirely. Undefined when
	 * `collectCoverage` is off or no package produced coverage data.
	 */
	coverageMapped?: MappedCoverageResult;
	merged: MultiProjectMerged;
	mode: "workspace";
	preCoverageMs: number;
	projectResults: Array<ProjectResult>;
	typecheckResult?: JestResult;
	validationExitCode?: 2;
	validationMessage?: string;
}

export type RunResult = MultiRunResult | SingleRunResult | WorkspaceRunResult;

export interface RunOptions {
	cli: CliOptions;
	config: ResolvedConfig;
}
