import { buildJestArgv, type JestArgv } from "../test-script.ts";
import type { ProjectJob } from "./interface.ts";

export interface WorkspaceEntry {
	config: JestArgv;
	pkg: string;
	project: string;
}

export interface ConfigEntries {
	configs: Array<JestArgv>;
	runtimeStubMounts: Array<Array<string>>;
}

/**
 * The per-(package, project) entries the plugin's Run-mode runner feeds to its
 * embedded materializer for a workspace run. Shared by both Studio backends —
 * studio-cli writes them into the bootstrap payload, the WebSocket studio
 * backend sends them in the `run_tests` message — so the entry shape can't drift
 * between the two transports.
 */
export function buildWorkspaceEntries(jobs: Array<ProjectJob>): Array<WorkspaceEntry> {
	return jobs.map((job) => {
		// The materializer keys every entry by `pkg` to clone the right package
		// from `__pkg_stage`. Workspace jobs are built all-or-none, so a missing
		// `pkg` means a malformed (mixed) array reached the backend — fail fast
		// rather than emit a `pkg`-less entry the runner can't use.
		if (job.pkg === undefined) {
			throw new Error(
				`studio-cli: workspace entry for project "${job.displayName}" is missing its package name (pkg)`,
			);
		}

		return { config: buildJestArgv(job), pkg: job.pkg, project: job.displayName };
	});
}

/**
 * The configs + filtered injection mounts the single-/multi-project configs path
 * consumes (`Runner.runProjects`). `runtimeStubMounts[i]` is parallel to
 * `configs[i]`: the DataModel paths the runner injects `jest.config` into,
 * excluding mounts where Rojo already syncs a user-authored config.
 */
export function buildConfigEntries(jobs: Array<ProjectJob>): ConfigEntries {
	return {
		configs: jobs.map((job) => buildJestArgv(job)),
		runtimeStubMounts: jobs.map((job) => job.runtimeInjectionPaths ?? []),
	};
}
