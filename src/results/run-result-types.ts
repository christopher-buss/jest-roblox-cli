import type { CoverageReporter } from "../config/config-types.ts";
import type { ResolvedConfig } from "../config/resolved-config.ts";
import type { CoverageArtifacts } from "../coverage-data/build-manifest.ts";
import type { CoverageDisplayPredicate } from "../coverage-report/agent-table-filter.ts";
import type { MappedCoverageResult } from "../coverage-report/mapper-types.ts";
import type { ExecuteResult } from "../executor/executor-types.ts";
import type { BailSummary } from "../types/bail-summary-types.ts";
import type { JestResult } from "../types/jest-result-types.ts";

/** The package and project a per-package sink files a result under. */
export interface SinkUnit {
	/** Package name. */
	pkg: string;
	/** Project name within the package. */
	project: string;
}

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
	/** Package and project of the result; workspace only. */
	unit?: SinkUnit | undefined;
}

/** One (package, project) pair's Type Test result. */
export interface UnitTypecheckResult extends SinkUnit {
	/** The package's Type Test result. */
	result: JestResult;
}

/** The phases every mode measures before the dispatch window opens. */
export interface PreDispatchTiming {
	/** The instrumentation bake; 0 without `--coverage`. */
	coverageMs: number;
	/** The stubs and the place build. */
	stagingMs: number;
}

/** One mapped coverage universe, its report target and its threshold. */
export interface CoverageReportUnit {
	/** Absolute output directory for the file reporters. */
	coverageDirectory: string;
	/** Threshold the unit is gated on; absent means no gate. */
	coverageThreshold?: ResolvedConfig["coverageThreshold"];
	/** Heads the report and prefixes threshold failures; the package name. */
	label?: string | undefined;
	/** Reporters that render the unit. */
	reporters: Array<CoverageReporter>;
	/** The mapped coverage. */
	universe: MappedCoverageResult;
}

/** The mapped coverage of a run. */
export interface RunCoverage {
	/** Why no unit could be mapped, for stderr. */
	notice?: string | undefined;
	/** Report units in report order. */
	units: Array<CoverageReportUnit>;
}

/** The resolved settings every output sink and the report read. */
export interface OutputSettings {
	/** Whether the run collected coverage. */
	collectCoverage: boolean;
	/** Whether output is colorized. */
	color: boolean;
	/** Formatters that render the run. */
	formatters: ResolvedConfig["formatters"];
	/** Aggregated Game Output path. */
	gameOutput?: string | undefined;
	/** Aggregated result file path. */
	outputFile?: string | undefined;
	/** Whether to write one Game Output file per (package, project). */
	perUnitGameOutput: boolean;
	/** Whether to write one result file per (package, project). */
	perUnitOutputFile: boolean;
	/** Directory paths are reported against and per-package files go under. */
	rootDir: string;
	/** Whether to include the translated Luau line in error output. */
	showLuau: boolean;
	/** Whether to suppress output. */
	silent: boolean;
	/** Seconds after which a single test is reported as slow. */
	slowTestThreshold?: number | undefined;
	/** Whether to print verbose output. */
	verbose: boolean;
}

/** Result of a run in either mode. */
export interface RunResult extends PreDispatchTiming {
	/** Totals precede selection; absent for a full run. */
	affected?: import("../formatters/shared.ts").AffectedSummary | undefined;
	/** How far a `--bail` run got; absent unless the run bailed. */
	bail?: BailSummary | undefined;
	/** Mapped coverage; absent when the run collected none. */
	coverage?: RunCoverage | undefined;
	/** Producer record for the entry point to emit a Build Manifest from. */
	coverageArtifacts?: CoverageArtifacts | undefined;
	/** Absolute source paths; undefined retains the full coverage universe. */
	coverageChangedFiles?: ReadonlyArray<string> | undefined;
	/** Narrows the agent coverage text table on a filtered run. */
	coverageDisplayFilter?: CoverageDisplayPredicate | undefined;
	/** Sink and render settings; absent when the run stopped before it ran. */
	output?: OutputSettings | undefined;
	/** Per-project results in run order. */
	projectResults: Array<ProjectResult>;
	/** Type Test result; absent when no type tests ran. */
	typecheckResult?: JestResult | undefined;
	/** Type Test result of each (package, project) pair; workspace only. */
	typecheckUnits?: Array<UnitTypecheckResult> | undefined;
	/** Exit code `2` when validation stopped the run. */
	validationExitCode?: 2 | undefined;
	/** Message the CLI writes to stderr on a validation stop. */
	validationMessage?: string | undefined;
}
