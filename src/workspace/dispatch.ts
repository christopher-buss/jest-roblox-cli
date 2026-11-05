import { randomUUID } from "node:crypto";

import type { Backend, ParallelOption, ProjectJob } from "../backends/interface.ts";
import { isShardedParallel } from "../backends/interface.ts";
import {
	buildProjectJob,
	type ExecuteResult,
	type RunProjects,
	runProjectsAsync,
	type RunProjectsOptions,
} from "../executor.ts";
import type { TsconfigMappingCache, TsconfigReader } from "../executor/tsconfig-mappings.ts";
import { prepareWorkStealingQueueAsync } from "../memory-store/work-stealing.ts";
import type { StreamingAggregatorOnEntry } from "../reporter/streaming-aggregator.ts";
import type { CodeBundleArtifact } from "../staging/code-bundle.ts";
import {
	generateMaterializerScript,
	type MaterializerInput,
} from "../staging/test-script-staged.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { PendingEntry } from "./pending-entry.ts";
import {
	tryStealingDispatchAsync,
	type WorkStealingCredentials,
} from "./work-stealing-dispatch.ts";

/** Run options that the dispatch preparation decides. */
export type WorkspaceDispatchSpec = Pick<
	RunProjectsOptions,
	| "bail"
	| "parallel"
	| "scriptFactory"
	| "scriptOverride"
	| "streaming"
	| "vmParallel"
	| "workStealing"
>;

/** Signature of the work-stealing queue preparation, injectable for tests. */
export type PrepareWorkStealingQueue = typeof prepareWorkStealingQueueAsync;

/**
 * A dispatch job carrying the package it belongs to. `ProjectJob.pkg` is
 * optional because multi mode has no packages; every workspace job has one,
 * and the materializer payload keys its entries by it.
 */
export interface WorkspaceJob extends ProjectJob {
	/** Package name. */
	pkg: string;
}

interface WorkspaceDispatchInput {
	/** Stop the run on the first failing package (`--bail`). */
	bail?: boolean | undefined;
	generateUuid?: (() => string) | undefined;
	jobs: Array<WorkspaceJob>;
	onStreamingResult?: StreamingAggregatorOnEntry | undefined;
	parallel?: ParallelOption;
	prepareWorkStealingQueue?: PrepareWorkStealingQueue | undefined;
	/** Studio-only: how many Luau VMs one package's projects split across. */
	vmParallel?: ParallelOption;
	workStealingCredentials: undefined | WorkStealingCredentials;
}

interface WorkspaceJobsInput {
	fileSystem: FileSystem;
	pending: Array<PendingEntry>;
	placeFile: string;
	tsconfigCache: TsconfigMappingCache;
	tsconfigReader: TsconfigReader;
}

interface DispatchedProjectsInput {
	backend: Backend | undefined;
	/**
	 * Forwarded to the backend, which uploads it as this run's binary input.
	 */
	codeBundle: CodeBundleArtifact | undefined;
	dispatchSpec: WorkspaceDispatchSpec;
	/** Where the run reads and writes. Defaults to the real filesystem. */
	fileSystem?: FileSystem | undefined;
	jobs: Array<WorkspaceJob>;
	runProjects?: RunProjects | undefined;
	startTime: number;
	timing: TimingCollector;
	tsconfigCache: TsconfigMappingCache;
	version: string;
}

/**
 * Runs every dispatch job against the shared place.
 *
 * The jobs handed in are the ones the dispatched script was built from, so the
 * run and the runtime agree on every project's config by identity rather than
 * by resolving it a second time.
 * @param input - Jobs, backend and run options.
 * @returns Results and the indices of the projects that ran.
 * @rejects When the backend run fails.
 */
export async function runDispatchedProjectsAsync(
	input: DispatchedProjectsInput,
): Promise<{ ranProjectIndices: Array<number>; results: Array<ExecuteResult> }> {
	const {
		dispatchSpec,
		fileSystem,
		jobs,
		runProjects = runProjectsAsync,
		startTime,
		timing,
		tsconfigCache,
		version,
	} = input;
	const { ranProjectIndices, results } = await timing.profileAsync("runProjects", async () => {
		return runProjects({
			// Defined whenever runtime jobs exist: only `--typecheckOnly`
			// omits the backend, and that path short-circuits before
			// reaching any runtime dispatch.
			// oxlint-disable-next-line typescript/no-non-null-assertion -- backend present for runtime jobs
			backend: input.backend!,
			codeBundle: input.codeBundle,
			deferFormatting: true,
			fileSystem,
			projects: jobs,
			startTime,
			timing,
			tsconfigCache,
			version,
			...dispatchSpec,
		});
	});

	return { ranProjectIndices, results };
}

/**
 * Resolve every pending (pkg, project) into the job it dispatches as, pinned to
 * the one synthesized place the whole workspace run shares.
 *
 * The run builds these once and hands the same array to both the script build
 * and the run itself, so the two cannot disagree about a project's config. The
 * `tsconfigCache` travels with them for the same reason: passed on to
 * `runProjectsAsync`, it keeps result post-processing on the scan taken here.
 * @param input - Pending entries, place file and tsconfig seams.
 * @returns One job per pending entry, in order.
 */
export function buildWorkspaceJobs({
	fileSystem,
	pending,
	placeFile,
	tsconfigCache,
	tsconfigReader,
}: WorkspaceJobsInput): Array<WorkspaceJob> {
	return pending.map((entry) => {
		const job = buildProjectJob({
			cache: tsconfigCache,
			fileSystem,
			project: {
				config: { ...entry.projectConfig, placeFile },
				displayColor: entry.project.displayColor,
				displayName: entry.project.displayName,
				pkg: entry.pkg,
				testFiles: entry.testFiles,
			},
			tsconfigReader,
		});

		return { ...job, pkg: entry.pkg };
	});
}

/**
 * Choose work-stealing or static dispatch for a workspace run.
 * @param input - Jobs, parallelism, streaming and queue seams.
 * @returns The dispatch options for `runProjectsAsync`.
 * @rejects When the work-stealing queue fails to prepare.
 */
export async function prepareWorkspaceDispatchAsync({
	bail = false,
	generateUuid = randomUUID,
	jobs,
	onStreamingResult,
	parallel,
	prepareWorkStealingQueue = prepareWorkStealingQueueAsync,
	vmParallel,
	workStealingCredentials,
}: WorkspaceDispatchInput): Promise<WorkspaceDispatchSpec> {
	const inputs = buildMaterializerInputs(jobs);

	// `runOptions.parallel` already reflects CLI > per-package consensus >
	// default. Only Open Cloud reaches this branch (work-stealing credentials
	// resolve nowhere else), so `"auto"` counts as sharded and is forwarded
	// unresolved — the backend turns it into a task count against the job
	// total, the same arithmetic multi's static bucketing does. A serial
	// backend runs one session whatever the count.
	if (workStealingCredentials !== undefined && isShardedParallel(parallel)) {
		const stealing = await tryStealingDispatchAsync({
			bail,
			credentials: workStealingCredentials,
			generateUuid,
			inputs,
			onStreamingResult,
			parallel,
			prepareWorkStealingQueue,
		});
		if (stealing !== undefined) {
			return stealing;
		}
	}

	return { ...deferrableDispatch({ bail, inputs, parallel }), vmParallel };
}

/**
 * A factory the backend builds every script from, matched on (pkg, project) —
 * the same pair the entries are keyed by.
 *
 * It answers two questions at once: it carves the run into `parallel` static
 * buckets, the concurrency this path keeps once the queue is out of reach, and
 * it re-sends the entries a task left behind when its return envelope filled
 * up. Nothing is pre-built, because a sharded run would throw a
 * whole-workspace script away.
 * @param options - Bail flag, materializer inputs and parallelism.
 * @param options.bail - Whether to stop on the first failing package.
 * @param options.inputs - One materializer input per job.
 * @param options.parallel - Static bucket count.
 * @returns Dispatch options with a script factory.
 */
function deferrableDispatch({
	bail,
	inputs,
	parallel,
}: {
	bail: boolean;
	inputs: Array<MaterializerInput>;
	parallel: ParallelOption;
}): WorkspaceDispatchSpec {
	const options = { bail };

	return {
		// The Studio hosts build their own payload from the jobs, not from
		// `scriptFactory`, so they read the flag here.
		bail,
		parallel,
		scriptFactory: (jobs) => {
			return generateMaterializerScript(
				inputs.filter((candidate) => {
					return jobs.some((job) => {
						return job.pkg === candidate.pkg && job.displayName === candidate.project;
					});
				}),
				options,
			);
		},
	};
}

/**
 * The materializer payload: one entry per (pkg, project) runtime job. It
 * carries the job's resolved config, because this script is frozen here —
 * anything resolved after it is built reaches multi mode only.
 * @param jobs - Workspace jobs to freeze.
 * @returns One materializer input per job.
 */
function buildMaterializerInputs(jobs: Array<WorkspaceJob>): Array<MaterializerInput> {
	return jobs.map((job) => {
		return {
			config: job.config,
			pkg: job.pkg,
			project: job.displayName,
			testFiles: job.testFiles,
		};
	});
}
