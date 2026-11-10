import type { Backend, DispatchKnobs } from "../backends/dispatch-request.ts";
import type { RunSettings } from "../backends/interface.ts";
import type { RunProgress } from "../progress/run-progress.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import type { TsconfigMappingCache, TsconfigReader } from "../tsconfig/tsconfig-mappings.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { ConfiguredJob } from "./executor-types.ts";
import type { ExecuteJobs, RunProjectsResult } from "./executor.ts";

/** Inputs of {@link dispatchJobsAsync}. */
export interface DispatchJobsInput {
	/** Backend that runs the jobs. */
	backend: Backend;
	/** How the jobs are spread: bail, sessions, VMs and workspace sharding. */
	dispatch: DispatchKnobs;
	/** Where the run reads and writes. */
	fileSystem: FileSystem;
	/** Jobs to run, each built once against the run's place. */
	jobs: Array<ConfiguredJob>;
	/** Stage reporter of the run. */
	progress: RunProgress;
	/** Dispatches built runtime jobs. */
	runProjects: ExecuteJobs;
	/** Run-wide settings, the same for every job. */
	runSettings: RunSettings;
	/** Profiler of the run. */
	timing: TimingCollector;
	/** Tsconfig mappings the jobs were built against. */
	tsconfigCache: TsconfigMappingCache;
	/** Reads tsconfig files. */
	tsconfigReader: TsconfigReader;
}

/**
 * Dispatch built runtime jobs, in either mode.
 * @param input - Backend, jobs, dispatch knobs and seams.
 * @returns Results of the jobs that ran, each naming its index into `jobs`.
 */
export async function dispatchJobsAsync({
	dispatch,
	runProjects,
	timing,
	...input
}: DispatchJobsInput): Promise<Pick<RunProjectsResult, "results">> {
	return timing.profileAsync("runProjects", async () => {
		const { results } = await runProjects({
			...input,
			...dispatch,
			startTime: Date.now(),
			timing,
		});
		return { results };
	});
}
