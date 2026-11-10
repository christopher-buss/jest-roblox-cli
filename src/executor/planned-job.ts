import type { ResolvedProjectConfig } from "../config/projects.ts";
import type { PlannedProject } from "../discovery/test-plan.ts";
import type { TsconfigMappingCache, TsconfigReader } from "../tsconfig/tsconfig-mappings.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { ConfiguredJob } from "./executor-types.ts";
import { buildProjectJob } from "./executor.ts";

/** Inputs of {@link buildPlannedJob}. */
export interface PlannedJobInput {
	/** File system the snapshot format is resolved on. */
	fileSystem: FileSystem;
	/** The planned project with runtime files. */
	planned: PlannedProject;
	/** Have the runner report its phase timings. */
	runnerTiming: boolean;
	/** DataModel paths of mounts that get a runtime stub. */
	runtimeInjectionPaths?: Array<string> | undefined;
	/** Tsconfig mappings shared across the run. */
	tsconfigCache: TsconfigMappingCache;
	/** Reads a tsconfig. */
	tsconfigReader: TsconfigReader;
}

/**
 * Build a planned project's job, and the project its stub is written from.
 * @param input - Planned project, package and tsconfig seams.
 * @returns The job, and the project carrying the job's resolved
 *   `snapshotFormat`, which the Clean Place reads only from the stub.
 */
export function buildPlannedJob({
	fileSystem,
	planned,
	runnerTiming,
	runtimeInjectionPaths,
	tsconfigCache,
	tsconfigReader,
}: PlannedJobInput): { job: ConfiguredJob; project: ResolvedProjectConfig } {
	const { project, runtimeFiles } = planned;
	const job = buildProjectJob({
		cache: tsconfigCache,
		fileSystem,
		project: {
			config: planned.config,
			displayColor: project.displayColor,
			displayName: project.displayName,
			runtimeInjectionPaths,
			testFiles: runtimeFiles,
		},
		runnerTiming,
		tsconfigReader,
	});
	return {
		job,
		project: {
			...project,
			config: { ...project.config, snapshotFormat: job.config.snapshotFormat },
		},
	};
}
