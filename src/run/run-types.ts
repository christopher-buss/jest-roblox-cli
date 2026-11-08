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
import type { AffectedSummary, BailSummary } from "../formatters/shared.ts";
import type { SourceMapper } from "../source-mapper/index.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import type { JestResult } from "../types/jest-result-types.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { RunSeams } from "./seams.ts";

/** Which run path produced a result. */
export type RunMode = "multi" | "single" | "workspace";

/** One project's display identity and execution result. */
export interface ProjectResult {
	/** Color of the project label; absent for the default. */
	displayColor?: string | undefined;
	/** Label the project prints under. */
	displayName: string;
	/** The project's execution result. */
	result: ExecuteResult;
	/** Package root its failure detail is shown relative to; workspace only. */
	rootDir?: string | undefined;
}

/** Coverage and source mapping folded across projects. */
export interface MultiProjectMerged {
	/** Merged coverage attribution, when coverage ran. */
	attribution?: NonNullable<ExecuteResult["attribution"]> | undefined;
	/** Merged raw coverage, when coverage ran. */
	coverageData?: NonNullable<ExecuteResult["coverageData"]> | undefined;
	/** Source mapper for the merged results. */
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

/** Result of a single-project run. */
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
	/** Discriminant of the run mode. */
	mode: "single";
	/** Runtime test result; absent when no runtime tests ran. */
	runtimeResult?: ExecuteResult | undefined;
	/** Type Test result; absent when no type tests ran. */
	typecheckResult?: JestResult | undefined;
	/** Exit code `2` when validation stopped the run. */
	validationExitCode?: 2 | undefined;
}

/** Result of a multi-project run. */
export interface MultiRunResult extends PreDispatchTiming {
	/** Partial Run only: how many test files it selected out of the total. */
	affected?: AffectedSummary | undefined;
	/** Coverage include globs resolved across the projects. */
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
	/** Coverage and source mapping folded across projects. */
	merged: MultiProjectMerged;
	/** Discriminant of the run mode. */
	mode: "multi";
	/** Per-project results in run order. */
	projectResults: Array<ProjectResult>;
	/** Type Test result; absent when no type tests ran. */
	typecheckResult?: JestResult | undefined;
	/** Exit code `2` when validation stopped the run. */
	validationExitCode?: 2 | undefined;
	/** Message the CLI writes to stderr on a validation stop or empty run. */
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
	/** Reporters that render the package's report. */
	coverageReporters: Array<CoverageReporter>;
	/** Threshold the package is gated on; absent means no gate. */
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
	/** Whether output is colorized. */
	color: boolean;
	/** Formatters that render the run. */
	formatters: Array<FormatterEntry>;
	/** Workspace root directory. */
	rootDir: string;
	/** Whether to suppress output. */
	silent: boolean;
	/** Whether to print verbose output. */
	verbose: boolean;
}

/** Result of a workspace run. */
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
	/** Coverage and source mapping folded across packages. */
	merged: MultiProjectMerged;
	/** Discriminant of the run mode. */
	mode: "workspace";
	/** Consensus-resolved aggregated result path the runner wrote (if any). */
	outputFile?: string | undefined;
	/** Per-package results in run order. */
	projectResults: Array<ProjectResult>;
	/**
	 * Render settings for the output layer. Absent on every result that never
	 * reached the runner — a validation bail, no affected packages, a run that
	 * tested nothing — each of which dispatch returns before the output layer
	 * sees it, on `validationExitCode` or on having neither project results nor
	 * a Type Test result.
	 */
	reportOptions?: undefined | WorkspaceReportOptions;
	/** Type Test result; absent when no type tests ran. */
	typecheckResult?: JestResult | undefined;
	/** Exit code `2` when validation stopped the run. */
	validationExitCode?: 2 | undefined;
	/** Message the CLI writes to stderr on a validation stop. */
	validationMessage?: string | undefined;
}

/** Result of any run mode, tagged by `mode`. */
export type RunResult = MultiRunResult | SingleRunResult | WorkspaceRunResult;

/** Inputs of one run. */
export interface RunOptions {
	/** Parsed command-line options. */
	cli: CliOptions;
	/** Resolved config of the run. */
	config: ResolvedConfig;
	/** Where the run reads and writes. Defaults to the real filesystem. */
	fileSystem?: FileSystem;
	/** Everything the run reaches outside itself through. */
	seams?: RunSeams | undefined;
	/**
	 * Span-tree profiler owned by `runJestRoblox`. Optional so direct test
	 * seams keep working with the existing two-property shape; production
	 * callers always pass one through.
	 */
	timing?: TimingCollector | undefined;
}
