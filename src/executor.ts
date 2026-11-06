import type {
	Backend,
	BackendResult,
	BackendTiming,
	ParallelOption,
	ProjectJob,
	StreamingHooks,
} from "./backends/interface.ts";
import type { ResolvedConfig } from "./config/schema.ts";
import { resolveSnapshotFormat } from "./config/snapshot-format.ts";
import type { ExecuteResult } from "./executor/executor-types.ts";
import { type EntryContext, processOrRecoverEntry } from "./executor/process-entry.ts";
import { recordBackendTimingSpans, recordLuauTimingSpans } from "./executor/timing-spans.ts";
import type { TsconfigMappingCache, TsconfigReader } from "./executor/tsconfig-mappings.ts";
import { createTsconfigMappingCache, nodeTsconfigReader } from "./executor/tsconfig-mappings.ts";
import type { CodeBundleArtifact } from "./staging/code-bundle.ts";
import { NOOP_TIMING_COLLECTOR, type TimingCollector } from "./timing/orchestration-collector.ts";
import type { FileSystem } from "./utils/file-system.ts";
import { nodeFileSystem } from "./utils/file-system.ts";

export type { ExecuteResult, FormatOutputOptions } from "./executor/executor-types.ts";
export { formatExecuteOutput } from "./executor/format-output.ts";

/** One project to run, before the executor resolves it into a job. */
export interface ProjectInput {
	/** Resolved config for this project. */
	config: ResolvedConfig;
	/** Color for the project label in output. */
	displayColor?: string | undefined;
	/** Label shown for the project in output. */
	displayName?: string | undefined;
	/** Workspace package this project belongs to. */
	pkg?: string | undefined;
	/** Studio-only: forwarded to `ProjectJob.runtimeInjectionPaths`. */
	runtimeInjectionPaths?: Array<string> | undefined;
	/** Test files the project runs. */
	testFiles: Array<string>;
}

/** Input to `runProjectsAsync`. */
export interface RunProjectsOptions {
	/** Backend that runs the jobs. */
	backend: Backend;
	/** Workspace mode: stop on the first failing package (`--bail`). */
	bail?: boolean | undefined;
	/**
	 * The Code Bundle the run's place was split from, forwarded to the backend
	 * as-is. Absent for a run that built the whole place.
	 */
	codeBundle?: CodeBundleArtifact | undefined;
	/** Skip formatting output per project; the caller formats later. */
	deferFormatting?: boolean | undefined;
	/** Where the run reads and writes. Defaults to the real filesystem. */
	fileSystem?: FileSystem | undefined;
	/** Parallelism forwarded to the backend. */
	parallel?: ParallelOption;
	/** Projects to run. */
	projects: Array<ProjectInput>;
	/** Builds the runtime script from the jobs, forwarded to the backend. */
	scriptFactory?: ((jobs: ReadonlyArray<ProjectJob>) => string) | undefined;
	/** Runtime script to use as-is, forwarded to the backend. */
	scriptOverride?: string | undefined;
	/** Run start time, in epoch milliseconds. */
	startTime: number;
	/** Hooks the backend calls as results stream in. */
	streaming?: StreamingHooks | undefined;
	/**
	 * Span-tree profiler owned by the top-level run. Optional so existing
	 * test seams (which exercise the executor directly) keep working without
	 * threading a collector through; production callers pass one through so
	 * the host waterfall captures `backend.runTests` + per-project
	 * post-processing.
	 */
	timing?: TimingCollector | undefined;
	/**
	 * Tsconfig mappings the caller has already read. Workspace mode resolves
	 * its jobs before it freezes the dispatched script and hands that cache on,
	 * so a package is scanned once for the whole run rather than once here and
	 * once there. Omit it and the run reads its own.
	 */
	tsconfigCache?: TsconfigMappingCache | undefined;
	/** How a tsconfig is read. Defaults to the real one. */
	tsconfigReader?: TsconfigReader | undefined;
	/** CLI version recorded in results. */
	version: string;
	/**
	 * Studio-only, experimental: how many Luau VMs the plugin splits the jobs
	 * across inside one Studio session. Every other backend ignores it.
	 */
	vmParallel?: ParallelOption;
	/** Work-stealing flag forwarded to the backend. */
	workStealing?: boolean | undefined;
}

/** Output of `runProjectsAsync`. */
export interface RunProjectsResult {
	/** Timing the backend reported for the dispatch. */
	backendTiming: BackendTiming;
	/**
	 * Which entries of `projects` the `results` are for, in the same order.
	 * Every index unless a `--bail` run stopped early, in which case the
	 * packages it never reached are absent — the caller lines its own
	 * per-project state up against this rather than against `projects`.
	 */
	ranProjectIndices: Array<number>;
	/** Processed result per project that ran. */
	results: Array<ExecuteResult>;
}

/** Input to `buildProjectJob`. */
export interface BuildProjectJobOptions {
	/** Tsconfig mappings shared across the run. */
	cache: TsconfigMappingCache;
	/** Where the job reads. Defaults to the real filesystem. */
	fileSystem?: FileSystem | undefined;
	/** Project to resolve. */
	project: ProjectInput;
	/** How a tsconfig is read. Defaults to the real one. */
	tsconfigReader?: TsconfigReader | undefined;
}

/** Signature of `runProjectsAsync`, for injection. */
export type RunProjects = typeof runProjectsAsync;

/**
 * Resolve one project into the job the runtime runs: `snapshotFormat` per
 * project, so the Luau runner never re-resolves or shares format state across
 * projects (fixes the spike's snapshot-diff regression — C1).
 *
 * Every runtime script is built from these jobs, in both dispatch modes — multi
 * through `runProjectsAsync` above, workspace through the materializer payload
 * (`buildMaterializerInputs`), which resolves its entries here before it
 * freezes the script. Per-project config resolution belongs in this one
 * function for that reason: resolve a field anywhere downstream of the payload
 * and it reaches multi mode only. `buildTestPlan` builds its jobs here too, so
 * the multi-mode stubs bake the same config.
 *
 * @param options - Project, tsconfig cache, filesystem and tsconfig reader.
 * @returns The job with its snapshot format resolved.
 */
export function buildProjectJob({
	cache,
	fileSystem = nodeFileSystem,
	project,
	tsconfigReader = nodeTsconfigReader,
}: BuildProjectJobOptions): ProjectJob {
	return {
		config: resolveSnapshotFormat({
			cache,
			config: project.config,
			fileSystem,
			testFiles: project.testFiles,
			tsconfigReader,
		}),
		displayColor: project.displayColor,
		displayName: project.displayName ?? "",
		pkg: project.pkg,
		runtimeInjectionPaths: project.runtimeInjectionPaths,
		testFiles: project.testFiles,
	};
}

/**
 * Unified orchestration entry point: builds jobs for every input project,
 * dispatches them through the backend in one call, shapes each raw envelope
 * entry into a `ProjectBackendResult`, then maps each through per-project
 * post-processing. Single-, multi-, and workspace-run callers all funnel
 * through here so the build→execute→shape→process sequence lives in
 * exactly one place.
 *
 * Ordering contract: `results` is in `options.projects` order, and parallel to
 * the returned `ranProjectIndices` — which is every project unless a `--bail`
 * run stopped short of some. Callers pair through that array, not by position
 * in `projects`. Backends MUST return `rawResults` in the order of the jobs
 * that ran, because `runProjects` walks the two together to recover each
 * project's resolved config, and a mismatch post-processes with the wrong one.
 *
 * @param options - Projects, backend and run settings.
 * @returns Results per project that ran, with the indices they map to.
 * @throws When the backend returns a different count of results than jobs that ran.
 */
export async function runProjectsAsync(options: RunProjectsOptions): Promise<RunProjectsResult> {
	const { fileSystem = nodeFileSystem, tsconfigReader = nodeTsconfigReader } = options;
	const timing = options.timing ?? NOOP_TIMING_COLLECTOR;
	const tsconfigCache = options.tsconfigCache ?? createTsconfigMappingCache();
	const jobs = buildRunJobs(options, { fileSystem, timing, tsconfigCache, tsconfigReader });

	const {
		bailedJobIndices,
		rawResults,
		timing: backendTiming,
	} = await dispatchToBackendAsync({ jobs, options, timing });

	const ranProjectIndices = selectRanIndices(jobs.length, bailedJobIndices);
	assertResultParity(rawResults.length, ranProjectIndices.length);

	const context: EntryContext = {
		backendTiming,
		deferFormatting: options.deferFormatting,
		fileSystem,
		startTime: options.startTime,
		timing,
		tsconfigCache,
		tsconfigReader,
		version: options.version,
	};

	const results = timing.profile("processResults", () => {
		return rawResults.map((raw, index) => {
			// oxlint-disable-next-line typescript/no-non-null-assertion -- length equality asserted above
			const job = jobs[ranProjectIndices[index]!]!;
			return processOrRecoverEntry({ context, job, raw });
		});
	});

	return { backendTiming, ranProjectIndices, results };
}

/**
 * One job per input project, resolved against the caches the run will reuse.
 * @param options - Run options holding the projects.
 * @param context - Filesystem, timing, tsconfig cache and reader.
 * @returns One job per project, in project order.
 */
function buildRunJobs(
	options: RunProjectsOptions,
	{
		fileSystem,
		timing,
		tsconfigCache,
		tsconfigReader,
	}: Pick<EntryContext, "fileSystem" | "timing" | "tsconfigCache" | "tsconfigReader">,
): Array<ProjectJob> {
	return timing.profile("buildJobs", () => {
		return options.projects.map((project) => {
			return buildProjectJob({ cache: tsconfigCache, fileSystem, project, tsconfigReader });
		});
	});
}

/**
 * The job indices a dispatch produced results for, in job order.
 * @param jobCount - Count of dispatched jobs.
 * @param bailedJobIndices - Job indices a bail skipped.
 * @returns Indices of jobs that ran.
 */
function selectRanIndices(
	jobCount: number,
	bailedJobIndices: Array<number> | undefined,
): Array<number> {
	const bailed = new Set(bailedJobIndices);
	return Array.from({ length: jobCount }, (_unused, index) => index).filter(
		(index) => !bailed.has(index),
	);
}

async function dispatchToBackendAsync({
	jobs,
	options,
	timing,
}: {
	jobs: Array<ProjectJob>;
	options: RunProjectsOptions;
	timing: TimingCollector;
}): Promise<BackendResult> {
	return timing.profileAsync("backend.runTests", async () => {
		const result = await options.backend.runTestsAsync({
			bail: options.bail,
			codeBundle: options.codeBundle,
			jobs,
			parallel: options.parallel,
			progress: timing.progress,
			scriptFactory: options.scriptFactory,
			scriptOverride: options.scriptOverride,
			streaming: options.streaming,
			vmParallel: options.vmParallel,
			workStealing: options.workStealing,
		});
		// Surface backend-measured upload/execute as nested spans of the
		// `backend.runTests` frame currently on the stack. These are
		// absolute numbers the backend already measured itself —
		// `record` injects them directly instead of re-timing in JS.
		recordBackendTimingSpans(timing, result.timing);
		// Same idea for the per-VM Luau phase breakdown: extracted here
		// (rather than from the parsed `ProjectBackendResult` in
		// `processResults` below) so the spans land under this frame
		// instead of the sibling `processResults` frame.
		recordLuauTimingSpans(timing, result.rawResults);
		return result;
	});
}

function assertResultParity(resultCount: number, jobCount: number): void {
	if (resultCount !== jobCount) {
		throw new Error(
			`Backend returned ${resultCount.toString()} results for ${jobCount.toString()} jobs — rawResults must be parallel to jobs`,
		);
	}
}
