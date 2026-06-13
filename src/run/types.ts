import type { CliOptions, ResolvedConfig } from "../config/schema.ts";
import type { CoverageArtifacts } from "../coverage-pipeline/build-manifest.ts";
import type { MappedCoverageResult } from "../coverage-pipeline/mapper.ts";
import type { ExecuteResult } from "../executor.ts";
import type { SourceMapper } from "../source-mapper/index.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import type { JestResult } from "../types/jest-result.ts";

export type RunMode = "multi" | "single" | "workspace";

export interface ProjectResult {
	displayColor?: string;
	displayName: string;
	result: ExecuteResult;
}

export interface MultiProjectMerged {
	attribution?: ExecuteResult["attribution"];
	coverageData?: ExecuteResult["coverageData"];
	sourceMapper?: SourceMapper;
}

export interface SingleRunResult {
	/**
	 * Producer record for the entry point to emit a Build Manifest from. Set only
	 * on a coverage run; an entry point reads it to write the manifest with the
	 * place set it has.
	 */
	coverageArtifacts?: CoverageArtifacts;
	mode: "single";
	preCoverageMs: number;
	runtimeResult?: ExecuteResult;
	typecheckResult?: JestResult;
	validationExitCode?: 2;
}

export interface MultiRunResult {
	collectCoverageFrom?: Array<string>;
	/** Producer record for the entry point to emit a Build Manifest from. */
	coverageArtifacts?: CoverageArtifacts;
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
	/**
	 * Consensus-resolved Aggregated Game Output path the runner wrote (if any).
	 * Surfaced so formatters point "View …" hints at the file that exists,
	 * rather than the workspace-root `config.gameOutput` (which the runner does
	 * not consult).
	 */
	gameOutput?: string;
	merged: MultiProjectMerged;
	mode: "workspace";
	/** Consensus-resolved aggregated result path the runner wrote (if any). */
	outputFile?: string;
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
	/**
	 * Span-tree profiler owned by `runJestRoblox`. Optional so direct test
	 * seams keep working with the existing two-property shape; production
	 * callers always pass one through.
	 */
	timing?: TimingCollector;
}
