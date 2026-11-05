import type { Backend } from "./backends/interface.ts";
import type { PackageConfigLoader } from "./config/loader.ts";
import type { CliOptions, WorkspaceRunOptions } from "./config/schema.ts";
import type { TsconfigReader } from "./executor/tsconfig-mappings.ts";
import type { StreamingAggregatorOnEntry } from "./reporter/streaming-aggregator.ts";
import type { TimingCollector } from "./timing/orchestration-collector.ts";
import type { RunTypecheck } from "./typecheck/runner.ts";
import type { ChildProcessRunner } from "./utils/child-process.ts";
import type { FileSystem } from "./utils/file-system.ts";
import type { RojoResolverFactory } from "./utils/rojo-project-reader.ts";
import type { PrepareCoverage } from "./workspace/coverage-attach.ts";
import type { PrepareWorkStealingQueue } from "./workspace/dispatch.ts";
import type { LoadedPackage } from "./workspace/package-loader.ts";
import type { PackageInfo } from "./workspace/package-resolver.ts";
import type { WorkspaceTestSelection } from "./workspace/test-selection.ts";

/** Inputs to one workspace run. */
export interface RunWorkspaceOptions {
	/**
	 * Open Cloud backend for the runtime dispatch. Optional: `--typecheckOnly`
	 * runs pure-local tsgo and short-circuits before any dispatch, so the
	 * caller omits the backend (and its credentials) entirely for type-only
	 * runs.
	 */
	backend?: Backend | undefined;
	/** Runs child processes. Defaults to the Node runner. */
	childProcess?: ChildProcessRunner;
	/** Parsed CLI options. */
	cli: CliOptions;
	/** Creates the rojo resolver. Defaults to the Node factory. */
	createResolver?: RojoResolverFactory;
	/**
	 * Directory a relative positional file resolves against — the one the CLI
	 * was invoked from, which is not the workspace root when the run was
	 * started inside a package. Optional so direct test seams keep working;
	 * production callers always pass one, and omitting it falls back to the
	 * value they would have passed.
	 */
	cwd?: string | undefined;
	/** Where the run reads and writes. Defaults to the real filesystem. */
	fileSystem?: FileSystem;
	/** Loads each package config. Defaults to `loadConfig`. */
	loadPackageConfig?: PackageConfigLoader;
	/**
	 * When provided, called once per newly-observed streaming result as
	 * packages complete (work-stealing mode only). The intended consumer is
	 * the human formatter, which uses this hook to flush per-package output
	 * to stdout as it lands. Omit for buffering formatters (JSON) so the
	 * final envelope is built once at task end.
	 */
	onStreamingResult?: StreamingAggregatorOnEntry | undefined;
	/** The workspace packages to run. */
	packageInfos: Array<PackageInfo>;
	/** Prepares coverage for the workspace. */
	prepareCoverage?: PrepareCoverage;
	/** Prepares the work-stealing queue. */
	prepareWorkStealingQueue?: PrepareWorkStealingQueue | undefined;
	/**
	 * Per-invocation knobs resolved by `buildWorkspaceRunOptions` —
	 * CLI > per-package consensus > defaults. The workspace runner does
	 * NOT read jest-shaped fields here; per-package config (loaded inside
	 * `loadWorkspacePackages`) is the source of truth for those.
	 */
	runOptions: WorkspaceRunOptions;
	/** Runs the type-test pass. Defaults to `runTypecheckAsync`. */
	runTypecheck?: RunTypecheck;
	/**
	 * Span-tree profiler created at the top of `runJestRoblox`. The
	 * workspace runner does NOT flush — the caller owns the lifecycle so a
	 * single `[TIMING]` waterfall covers the whole invocation rather than
	 * emitting a half-tree if a downstream phase throws. Optional so direct
	 * test seams keep working; production callers always pass one.
	 */
	timing?: TimingCollector | undefined;
	/** Reads tsconfig files. Defaults to the Node reader. */
	tsconfigReader?: TsconfigReader;
	/** CLI version. */
	version: string;
	/** Absolute workspace root directory. */
	workspaceRoot: string;
	/**
	 * Credentials used to coordinate work-stealing across parallel OCALE
	 * tasks via a memory-store queue. When provided alongside
	 * `cli.parallel > 1`, the workspace runner pushes every (pkg, project)
	 * onto a per-run UUID queue and the backend fires N tasks all running
	 * the same materializer script. Without it (or with parallel=1) the
	 * runner uses the embedded-entries path, where the backend buckets the
	 * entries statically instead.
	 */
	workStealingCredentials?:
		| undefined
		| {
				/** Open Cloud API key. */
				apiKey: string;
				/** Open Cloud base URL override. */
				baseUrl?: string | undefined;
				/** Universe that owns the memory store. */
				universeId: string;
		  };
}

/**
 * The options every stage below the entry point reads: the caller's, with the
 * collaborator seams already resolved. Resolving them once — rather than at
 * each fallback to `nodeFileSystem` — is what stops a stage reaching the real
 * disk (or launching a real rojo) because someone forgot the fallback.
 */
export type ResolvedRunWorkspaceOptions = RunWorkspaceOptions & {
	childProcess: ChildProcessRunner;
	createResolver: RojoResolverFactory;
	fileSystem: FileSystem;
	loadPackageConfig: PackageConfigLoader;
	prepareCoverage: PrepareCoverage;
	runTypecheck: RunTypecheck;
	tsconfigReader: TsconfigReader;
};

/** Inputs to the runtime stages of a workspace run. */
export interface WorkspaceRuntimeInput {
	/** Workspace cache directory. */
	cacheDirectory: string;
	/** Every loaded package. */
	loaded: Array<LoadedPackage>;
	/** Resolved run options. */
	options: ResolvedRunWorkspaceOptions;
	/** Tests selected for the run. */
	selection: WorkspaceTestSelection;
	/** Span-tree profiler for the run. */
	timing: TimingCollector;
}

/**
 * What a run has in hand once every package has loaded and passed preflight.
 */
export type OpenedWorkspace = Pick<WorkspaceRuntimeInput, "cacheDirectory" | "loaded">;
