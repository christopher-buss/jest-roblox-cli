import type {
	CliOptions,
	CoverageReporter,
	FormatterEntry,
	ResolvedConfig,
} from "../config/schema.ts";
import type { CoverageDisplayPredicate } from "../coverage-pipeline/agent-table-filter.ts";
import type { CoverageArtifacts } from "../coverage-pipeline/build-manifest.ts";
import type { WorkspacePackageUniverse } from "../coverage-pipeline/workspace-aggregate.ts";
import type { ExecuteResult } from "../executor.ts";
import type { BailSummary } from "../formatters/shared.ts";
import type { SourceMapper } from "../source-mapper/index.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import type { JestResult } from "../types/jest-result.ts";
import type { FileSystem } from "../utils/file-system.ts";

export type RunMode = "multi" | "single" | "workspace";

export interface ProjectResult {
	displayColor?: string | undefined;
	displayName: string;
	result: ExecuteResult;
}

export interface MultiProjectMerged {
	attribution?: NonNullable<ExecuteResult["attribution"]> | undefined;
	coverageData?: NonNullable<ExecuteResult["coverageData"]> | undefined;
	sourceMapper?: SourceMapper | undefined;
}

/**
 * The two phases every mode measures outside the dispatch window: the coverage
 * instrumentation bake, and the staging around it — stubs and the place build.
 *
 * The window opens after both, so the print layer adds them onto the reported
 * total rather than finding them inside it, and each prints under its own name
 * — leave either unmeasured and the `cli` residual silently absorbs it, which
 * is what hid workspace staging before. Every mode fills both the same way, so
 * multi and workspace report equivalent work as the same phases.
 */
export interface PreDispatchTiming {
	/** The instrumentation bake, and nothing else. 0 without `--coverage`. */
	coverageMs: number;
	/** The stubs and the place build, which a run pays either way. */
	stagingMs: number;
}

export interface SingleRunResult extends PreDispatchTiming {
	/**
	 * Producer record for the entry point to emit a Build Manifest from. Set
	 * only on a coverage run; an entry point reads it to write the manifest
	 * with the place set it has.
	 */
	coverageArtifacts?: CoverageArtifacts | undefined;
	/**
	 * Narrows the agent coverage **text table** to the directly-filtered
	 * source files on a filtered run (single file / `--testPathPattern`).
	 * Display-only: thresholds, totals, and lcov/html/json keep the full
	 * universe. Undefined on a full run.
	 */
	coverageDisplayFilter?: CoverageDisplayPredicate | undefined;
	mode: "single";
	runtimeResult?: ExecuteResult | undefined;
	typecheckResult?: JestResult | undefined;
	validationExitCode?: 2 | undefined;
}

export interface MultiRunResult extends PreDispatchTiming {
	collectCoverageFrom?: Array<string> | undefined;
	/** Producer record for the entry point to emit a Build Manifest from. */
	coverageArtifacts?: CoverageArtifacts | undefined;
	/**
	 * Narrows the agent coverage **text table** to the directly-filtered source
	 * files on a filtered run (positional files / `--testPathPattern`, or the
	 * selected `--project` scope). Display-only: thresholds, totals, and
	 * lcov/html/json keep the full universe. Undefined on a full run.
	 */
	coverageDisplayFilter?: CoverageDisplayPredicate | undefined;
	merged: MultiProjectMerged;
	mode: "multi";
	projectResults: Array<ProjectResult>;
	typecheckResult?: JestResult | undefined;
	validationExitCode?: 2 | undefined;
	validationMessage?: string | undefined;
}

/**
 * One package's coverage report and gate: its own mapped universe — already
 * narrowed by that package's `collectCoverageFrom` and
 * `coveragePathIgnorePatterns` in `aggregateWorkspaceCoverage`, where package
 * identity was still known — plus where the report is written, which reporters
 * render it, and the threshold it is judged against.
 *
 * `coverageThreshold` is undefined when the package never declared one, in
 * which case nothing gates the package: a workspace run has no config of its
 * own to take a base threshold from.
 */
export interface WorkspacePackageCoverageGate extends WorkspacePackageUniverse {
	/**
	 * Absolute: the package's `coverageDirectory` against its own `rootDir`.
	 */
	coverageDirectory: string;
	coverageReporters: Array<CoverageReporter>;
	coverageThreshold?: ResolvedConfig["coverageThreshold"];
}

/**
 * What the report and print layers render a workspace run under: the runner's
 * consensus-resolved render settings plus the workspace root.
 *
 * Workspace mode loads the config file at cwd for `workspace.root` /
 * `workspace.packages` only, so the output layer has no config of its own to
 * read. These values travel on the result instead — without them the layer
 * would fall back to whichever config happened to sit at the invocation
 * directory, and the same run would answer the same question two ways.
 */
export interface WorkspaceReportOptions {
	color: boolean;
	formatters: Array<FormatterEntry>;
	rootDir: string;
	silent: boolean;
	verbose: boolean;
}

export interface WorkspaceRunResult extends PreDispatchTiming {
	/**
	 * How far a `--bail` run got before a failing package stopped it. Absent
	 * unless the run bailed, so `projectResults` covers every selected package.
	 */
	bail?: BailSummary | undefined;
	/**
	 * Per-package coverage reports and gates, in aggregation order. Undefined
	 * when no package carries a coverage manifest; present (possibly empty)
	 * whenever coverage ran. The report layer emits one report per entry and
	 * gates each package on its own — there is no cross-package merge, so no
	 * single-package `loadCoverageManifest(rootDir)` lookup either.
	 */
	coveragePackages?: Array<WorkspacePackageCoverageGate> | undefined;
	/**
	 * Consensus-resolved Aggregated Game Output path the runner wrote (if any).
	 * Surfaced so formatters point "View …" hints at the file that exists,
	 * rather than the workspace-root `config.gameOutput` (which the runner does
	 * not consult).
	 */
	gameOutput?: string | undefined;
	merged: MultiProjectMerged;
	mode: "workspace";
	/** Consensus-resolved aggregated result path the runner wrote (if any). */
	outputFile?: string | undefined;
	projectResults: Array<ProjectResult>;
	/**
	 * Render settings for the output layer. Absent on every result that never
	 * reached the runner — a validation bail, no affected packages, a run that
	 * tested nothing — each of which dispatch returns before the output layer
	 * sees it, on `validationExitCode` or on having neither project results nor
	 * a Type Test result.
	 */
	reportOptions?: undefined | WorkspaceReportOptions;
	typecheckResult?: JestResult | undefined;
	validationExitCode?: 2 | undefined;
	validationMessage?: string | undefined;
}

export type RunResult = MultiRunResult | SingleRunResult | WorkspaceRunResult;

export interface RunOptions {
	cli: CliOptions;
	config: ResolvedConfig;
	/** Where the run reads and writes. Defaults to the real filesystem. */
	fileSystem?: FileSystem;
	/**
	 * Span-tree profiler owned by `runJestRoblox`. Optional so direct test
	 * seams keep working with the existing two-property shape; production
	 * callers always pass one through.
	 */
	timing?: TimingCollector | undefined;
}
