import { buildJestArgv, type JestArgv } from "../test-script.ts";
import { isWorkspaceRun, type ProjectJob } from "./interface.ts";

export type RunPayload = ConfigRunPayload | WorkspaceRunPayload;

interface ConfigRunPayload {
	config: { configs: Array<JestArgv> };
	runtimeStubMounts: Array<Array<string>>;
}

interface WorkspaceEntry {
	config: JestArgv;
	pkg: string;
	project: string;
}

interface WorkspaceRunPayload {
	workspace: { entries: Array<WorkspaceEntry> };
}

interface ConfigEntries {
	configs: Array<JestArgv>;
	runtimeStubMounts: Array<Array<string>>;
}

/**
 * Build the runner payload shared by both Studio transports. The transports
 * add their own protocol envelope, while this seam owns the config/workspace
 * dispatch shape consumed by the Run-mode runner.
 */
export function buildRunPayload(jobs: Array<ProjectJob>): RunPayload {
	if (isWorkspaceRun(jobs)) {
		return { workspace: { entries: buildWorkspaceEntries(jobs) } };
	}

	const { configs, runtimeStubMounts } = buildConfigEntries(jobs);
	return { config: { configs }, runtimeStubMounts };
}

/**
 * The per-(package, project) entries the plugin's Run-mode runner feeds to its
 * embedded materializer for a workspace run. Shared by both Studio backends —
 * studio-cli writes them into the bootstrap payload, the WebSocket studio
 * backend sends them in the `run_tests` message — so the entry shape can't
 * drift between the two transports.
 */
function buildWorkspaceEntries(jobs: Array<ProjectJob>): Array<WorkspaceEntry> {
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
 * The configs + filtered injection mounts the single-/multi-project configs
 * path consumes (`Runner.runProjects`). `runtimeStubMounts[i]` is parallel to
 * `configs[i]`: the DataModel paths the runner injects `jest.config` into,
 * excluding mounts where Rojo already syncs a user-authored config.
 */
function buildConfigEntries(jobs: Array<ProjectJob>): ConfigEntries {
	return {
		configs: jobs.map((job) => buildJestArgv(job)),
		runtimeStubMounts: jobs.map((job) => job.runtimeInjectionPaths ?? []),
	};
}
