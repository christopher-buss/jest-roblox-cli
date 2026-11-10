import type { CliOptions, WorkspaceRunOptions } from "../config/resolved-config.ts";
import type { SetupResolverFactory } from "../config/setup-resolver.ts";
import type { ExecuteJobs } from "../executor/executor.ts";
import type { RunProgress } from "../progress/run-progress.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import type { TsconfigReader } from "../tsconfig/tsconfig-mappings.ts";
import type { RunTypecheck } from "../typecheck/runner.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { PrepareCoverage } from "./coverage-attach.ts";
import type { LoadedPackage, WorkspacePackage } from "./package-loader.ts";
import type { StreamingAggregatorOnEntry } from "./streaming-aggregator.ts";

/** Inputs to one workspace run. */
export interface RunWorkspaceOptions {
	/** Runs child processes. */
	childProcess: ChildProcessRunner;
	/** Parsed CLI options. */
	cli: CliOptions;
	/** Creates the rojo resolver. */
	createSetupResolver: SetupResolverFactory;
	/** Directory a relative positional file resolves against. */
	cwd: string;
	/** Where the run reads and writes. */
	fileSystem: FileSystem;
	/** Called once per new streaming result, in work-stealing mode. */
	onStreamingResult?: StreamingAggregatorOnEntry | undefined;
	/** The workspace packages to run, with their loaded configs. */
	packages: Array<WorkspacePackage>;
	/** Prepares coverage for the workspace. */
	prepareCoverage: PrepareCoverage;
	/** Stage reporter of the run. */
	progress: RunProgress;
	/** Run-wide options; jest-shaped fields come from package config. */
	runOptions: WorkspaceRunOptions;
	/** Dispatches built runtime jobs. */
	runProjects: ExecuteJobs;
	/** Runs the type-test pass. */
	runTypecheck: RunTypecheck;
	/** Span-tree profiler of the run; the caller flushes it. */
	timing: TimingCollector;
	/** Reads tsconfig files. */
	tsconfigReader: TsconfigReader;
	/** Absolute workspace root directory. */
	workspaceRoot: string;
}

/** A workspace whose packages loaded and passed preflight. */
export interface OpenedWorkspace {
	/** Workspace cache directory. */
	cacheDirectory: string;
	/** Every loaded package. */
	loaded: Array<LoadedPackage>;
}
