import type { CliOptions, ResolvedConfig } from "../config/schema.ts";
import type { CoverageDisplayPredicate } from "../coverage-pipeline/agent-table-filter.ts";
import type { CoverageArtifacts } from "../coverage-pipeline/build-manifest.ts";
import type { MappedCoverageResult } from "../coverage-pipeline/mapper.ts";
import type { WorkspacePackageUniverse } from "../coverage-pipeline/workspace-aggregate.ts";
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
	/**
	 * Narrows the agent coverage **text table** to the directly-filtered source
	 * files on a filtered run (single file / `--testPathPattern`). Display-only:
	 * thresholds, totals, and lcov/html/json keep the full universe. Undefined on
	 * a full run.
	 */
	coverageDisplayFilter?: CoverageDisplayPredicate;
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
	/**
	 * Narrows the agent coverage **text table** to the directly-filtered source
	 * files on a filtered run (positional files / `--testPathPattern`, or the
	 * selected `--project` scope). Display-only: thresholds, totals, and
	 * lcov/html/json keep the full universe. Undefined on a full run.
	 */
	coverageDisplayFilter?: CoverageDisplayPredicate;
	merged: MultiProjectMerged;
	mode: "multi";
	preCoverageMs: number;
	projectResults: Array<ProjectResult>;
	typecheckResult?: JestResult;
	validationExitCode?: 2;
	validationMessage?: string;
}

/**
 * One package's coverage gate: its own mapped universe plus its declared
 * threshold. The report layer judges each package against its own universe;
 * `coverageThreshold` is undefined when the package never declared one, in
 * which case the workspace root's threshold applies (metric-level merge).
 */
export interface WorkspacePackageCoverageGate extends WorkspacePackageUniverse {
	coverageThreshold?: ResolvedConfig["coverageThreshold"];
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
	 * Per-package coverage gates, in aggregation order. Undefined when no
	 * package carries a coverage manifest; present (possibly empty) whenever
	 * coverage ran, so the report layer enforces thresholds per package.
	 */
	coveragePackages?: Array<WorkspacePackageCoverageGate>;
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
