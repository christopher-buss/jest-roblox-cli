import type { Except } from "type-fest";

import { withRojoProject } from "./config/rojo-project.ts";
import type { ConfiguredJob } from "./executor/executor-types.ts";
import {
	buildProjectJob,
	executeJobsAsync,
	type ExecuteJobsOptions,
	type JobResult,
	type ProjectInput,
	type RunProjectsResult,
} from "./executor/executor.ts";
import type { EntryContext } from "./executor/process-entry.ts";
import { formatExecuteOutput } from "./formatters/format-output.ts";
import { NOOP_TIMING_COLLECTOR, type TimingCollector } from "./timing/orchestration-collector.ts";
import {
	createTsconfigMappingCache,
	nodeTsconfigReader,
	type TsconfigMappingCache,
	type TsconfigReader,
} from "./tsconfig/tsconfig-mappings.ts";
import { type FileSystem, nodeFileSystem } from "./utils/file-system.ts";

/** Input to `runProjectsAsync`. */
export interface RunProjectsOptions extends Except<
	ExecuteJobsOptions,
	"fileSystem" | "jobs" | "timing" | "tsconfigCache" | "tsconfigReader"
> {
	/** Where the run reads and writes. Defaults to the real filesystem. */
	fileSystem?: FileSystem | undefined;
	/** Projects to run. */
	projects: Array<ProjectInput>;
	/** Span-tree profiler owned by the top-level run. */
	timing?: TimingCollector | undefined;
	/** Tsconfig mappings the caller has already read. */
	tsconfigCache?: TsconfigMappingCache | undefined;
	/** How a tsconfig is read. Defaults to the real one. */
	tsconfigReader?: TsconfigReader | undefined;
	/** CLI version recorded in results. */
	version: string;
}

/** One project's result with its terminal output. */
export interface FormattedExecuteResult extends JobResult {
	/** The result rendered for the project's formatter; empty when silent. */
	output: string;
}

/** Output of `runProjectsAsync`. */
export interface FormattedRunProjectsResult extends RunProjectsResult {
	/** Processed and rendered result per project that ran. */
	results: Array<FormattedExecuteResult>;
}

/**
 * Build, dispatch and post-process every project.
 * @param options - Projects, backend and run settings.
 * @returns Results per project that ran, each naming its job.
 * @throws When a backend result names no job, a job twice, or a job is
 *   missing from a run that did not bail.
 */
export async function runProjectsAsync(
	options: RunProjectsOptions,
): Promise<FormattedRunProjectsResult> {
	const { fileSystem = nodeFileSystem, tsconfigReader = nodeTsconfigReader } = options;
	const seams = {
		fileSystem,
		timing: options.timing ?? NOOP_TIMING_COLLECTOR,
		tsconfigCache: options.tsconfigCache ?? createTsconfigMappingCache(),
		tsconfigReader,
	};
	const jobs = buildRunJobs(options, seams);
	const run = await executeJobsAsync({ ...options, ...seams, jobs });
	return {
		...run,
		results: run.results.map((result) => {
			// oxlint-disable-next-line typescript/no-non-null-assertion -- the executor checked every index
			const { config } = jobs[result.jobIndex]!;
			return {
				...result,
				output: formatExecuteOutput({
					config,
					result: result.result,
					snapshotWriteFailures: result.snapshotWriteFailures,
					sourceMapper: result.sourceMapper,
					timing: result.timing,
					version: options.version,
				}),
			};
		}),
	};
}

function buildRunJobs(
	options: RunProjectsOptions,
	{
		fileSystem,
		timing,
		tsconfigCache,
		tsconfigReader,
	}: Pick<EntryContext, "fileSystem" | "timing" | "tsconfigCache" | "tsconfigReader">,
): Array<ConfiguredJob> {
	return timing.profile("buildJobs", () => {
		return options.projects.map((project) => {
			return buildProjectJob({
				cache: tsconfigCache,
				fileSystem,
				project: { ...project, config: withRojoProject(project.config, fileSystem) },
				runnerTiming: timing.enabled,
				tsconfigReader,
			});
		});
	});
}
