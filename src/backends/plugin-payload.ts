import { buildJestArgv, type JestArgv } from "../test-script.ts";
import { isWorkspaceRun, type ParallelOption, type ProjectJob } from "./interface.ts";
import { resolveVmHostCount } from "./vm-parallel.ts";

export type RunPayload = ConfigRunPayload | WorkspaceRunPayload;

export interface RunPayloadRequest {
	jobs: Array<ProjectJob>;
	/** The transport's own run timeout, in milliseconds. */
	runBudgetMs: number;
	/**
	 * Experimental in-session parallelism: the VM count the user asked for, or
	 * `"auto"` for one per config. Undefined on every ordinary run.
	 */
	vmParallel?: ParallelOption;
}

interface ConfigRunPayload {
	config: { configs: Array<JestArgv> };
	/**
	 * How long the caller will wait for the whole run, in milliseconds. Sent
	 * only alongside `vmParallel`: the coordinator's wait for its hosts has to
	 * end inside this, or the ExecutionError entries it produces for a dead
	 * host reach a CLI that stopped listening.
	 */
	runBudgetMs?: number;
	runtimeStubMounts: Array<Array<string>>;
	/**
	 * Experimental: how many Luau VMs the run-mode runner splits `configs`
	 * across. Absent means the sequential path — which is also where a request
	 * for a single VM lands, since one VM is what sequential already is.
	 */
	vmParallel?: number;
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
export function buildRunPayload({ jobs, runBudgetMs, vmParallel }: RunPayloadRequest): RunPayload {
	if (isWorkspaceRun(jobs)) {
		return { workspace: { entries: buildWorkspaceEntries(jobs) } };
	}

	const { configs, runtimeStubMounts } = buildConfigEntries(jobs);
	const hostCount = resolveVmHostCount(vmParallel, configs.length);
	if (hostCount === undefined) {
		return { config: { configs }, runtimeStubMounts };
	}

	return { config: { configs }, runBudgetMs, runtimeStubMounts, vmParallel: hostCount };
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
