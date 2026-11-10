import type { Except } from "type-fest";

import { type Backend, dispatchAsync, type DispatchPlan } from "../backends/dispatch-request.ts";
import type {
	BackendResult,
	BackendTiming,
	ProjectJob,
	RawBackendEntry,
} from "../backends/interface.ts";
import type { ResolvedConfig } from "../config/resolved-config.ts";
import { buildJestArgv } from "../runner-payload/jest-argv.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import type { TsconfigMappingCache, TsconfigReader } from "../tsconfig/tsconfig-mappings.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { ConfiguredJob, ExecuteResult } from "./executor-types.ts";
import { type EntryContext, processOrRecoverEntry } from "./process-entry.ts";
import { resolveSnapshotFormat } from "./snapshot-format.ts";
import { recordBackendTimingSpans, recordLuauTimingSpans } from "./timing-spans.ts";

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
	/** Studio-only: forwarded to `ConfiguredJob.runtimeInjectionPaths`. */
	runtimeInjectionPaths?: Array<string> | undefined;
	/** Test files the project runs. */
	testFiles: Array<string>;
}

/** Input to `executeJobsAsync`. */
export interface ExecuteJobsOptions extends Except<DispatchPlan, "jobs"> {
	/** Backend that runs the jobs. */
	backend: Backend;
	/** Where the run reads and writes. */
	fileSystem: FileSystem;
	/** Jobs to dispatch, in order. */
	jobs: Array<ConfiguredJob>;
	/** Run start time, in epoch milliseconds. */
	startTime: number;
	/** Span-tree profiler owned by the top-level run. */
	timing: TimingCollector;
	/** Tsconfig mappings the jobs were built against. */
	tsconfigCache: TsconfigMappingCache;
	/** How a tsconfig is read. */
	tsconfigReader: TsconfigReader;
}

/** One job's processed result, naming the job it answers. */
export interface JobResult extends ExecuteResult {
	/** Index of the job in the request. */
	jobIndex: number;
}

/** Output of `executeJobsAsync`. */
export interface RunProjectsResult {
	/** Timing the backend reported for the dispatch. */
	backendTiming: BackendTiming;
	/** Processed result per job that ran, in job order. */
	results: Array<JobResult>;
}

/** Input to `buildProjectJob`. */
export interface BuildProjectJobOptions {
	/** Tsconfig mappings shared across the run. */
	cache: TsconfigMappingCache;
	/** Where the job reads. */
	fileSystem: FileSystem;
	/** Project to resolve. */
	project: ProjectInput;
	/** Have the runner report its phase timings. */
	runnerTiming?: boolean | undefined;
	/** How a tsconfig is read. */
	tsconfigReader: TsconfigReader;
}

/** Signature of `executeJobsAsync`, for injection. */
export type ExecuteJobs = typeof executeJobsAsync;

/**
 * Dispatch built jobs and post-process each result.
 * @param options - Jobs, their tsconfig cache, backend and run settings.
 * @returns Results per job that ran, each naming its job.
 * @throws When a backend result names no job, a job twice, or a job is
 *   missing from a run that did not bail.
 */
export async function executeJobsAsync(options: ExecuteJobsOptions): Promise<RunProjectsResult> {
	const { fileSystem, jobs, timing, tsconfigCache, tsconfigReader } = options;

	const backendResult = await dispatchToBackendAsync({ jobs, options, timing });
	const ran = pairByJobIndex(jobs, backendResult);

	const context: EntryContext = {
		backendTiming: backendResult.timing,
		fileSystem,
		startTime: options.startTime,
		timing,
		tsconfigCache,
		tsconfigReader,
	};

	const results = timing.profile("processResults", () => {
		return ran.map(({ job, jobIndex, raw }) => {
			return { ...processOrRecoverEntry({ context, job, raw }), jobIndex };
		});
	});

	return { backendTiming: backendResult.timing, results };
}

/**
 * Resolve one project into the job the runtime runs. Resolve per-project
 * fields here: the workspace materializer freezes jobs before dispatch.
 * @param options - Project, tsconfig cache, filesystem and tsconfig reader.
 * @returns The job with its snapshot format resolved.
 */
export function buildProjectJob({
	cache,
	fileSystem,
	project,
	runnerTiming,
	tsconfigReader,
}: BuildProjectJobOptions): ConfiguredJob {
	const config = resolveSnapshotFormat({
		cache,
		config: project.config,
		fileSystem,
		testFiles: project.testFiles,
		tsconfigReader,
	});
	return {
		argv: buildJestArgv({ config, runnerTiming }),
		config,
		displayColor: project.displayColor,
		displayName: project.displayName ?? "",
		pkg: project.pkg,
		runtimeInjectionPaths: project.runtimeInjectionPaths,
		testFiles: project.testFiles,
	};
}

function indexRawResults(
	jobs: ReadonlyArray<ProjectJob>,
	rawResults: ReadonlyArray<RawBackendEntry>,
): Map<number, RawBackendEntry> {
	const byIndex = new Map<number, RawBackendEntry>();
	for (const raw of rawResults) {
		const job = jobs[raw.jobIndex];
		if (job === undefined) {
			throw new Error(
				`Backend returned a result for job ${raw.jobIndex.toString()}, but the run has ${jobs.length.toString()} jobs`,
			);
		}

		if (byIndex.has(raw.jobIndex)) {
			throw new Error(
				`Backend returned two results for job ${raw.jobIndex.toString()} (${job.displayName})`,
			);
		}

		byIndex.set(raw.jobIndex, raw);
	}

	return byIndex;
}

function pairByJobIndex<Job extends ProjectJob>(
	jobs: Array<Job>,
	{ bailed, rawResults }: Pick<BackendResult, "bailed" | "rawResults">,
): Array<{ job: Job; jobIndex: number; raw: RawBackendEntry }> {
	const byIndex = indexRawResults(jobs, rawResults);
	const ran: Array<{ job: Job; jobIndex: number; raw: RawBackendEntry }> = [];
	const missing: Array<string> = [];
	for (const [jobIndex, job] of jobs.entries()) {
		const raw = byIndex.get(jobIndex);
		if (raw === undefined) {
			missing.push(job.displayName);
		} else {
			ran.push({ job, jobIndex, raw });
		}
	}

	if (bailed !== true && missing.length > 0) {
		throw new Error(
			`Backend returned no result for ${missing.length.toString()} job(s): ${missing.join(", ")}`,
		);
	}

	return ran;
}

async function dispatchToBackendAsync({
	jobs,
	options,
	timing,
}: {
	jobs: Array<ConfiguredJob>;
	options: ExecuteJobsOptions;
	timing: TimingCollector;
}): Promise<BackendResult> {
	return timing.profileAsync("backend.runTests", async () => {
		const result = await dispatchAsync(options.backend, {
			bail: options.bail,
			jobs,
			parallel: options.parallel,
			progress: options.progress,
			runSettings: options.runSettings,
			vmParallel: options.vmParallel,
			workspace: options.workspace,
		});
		// Must run inside this frame so the spans nest under `backend.runTests`.
		recordBackendTimingSpans(timing, result.timing);
		recordLuauTimingSpans(timing, result.rawResults);
		return result;
	});
}
