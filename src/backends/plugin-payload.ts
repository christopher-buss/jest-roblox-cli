import type { EmbeddedPayload } from "../protocol/embedded-payload-types.ts";
import { type StudioConfigEntry, VM_HOST_POOL_SIZE } from "../protocol/studio.ts";
import { indexArgv, type IndexedJestArgv } from "../runner-payload/jest-argv.ts";
import { toMaterializerEntry } from "../runner-payload/materializer-script.ts";
import type { DecodedEnvelope } from "./envelope.ts";
import type { BackendResult, DispatchBase, ParallelOption } from "./interface.ts";

/** Payload the Run-mode runner reads: a configs run or a workspace run. */
export type RunPayload = ConfigRunPayload | WorkspaceRunPayload;

const UNBOUNDED_RESULT_BUDGET_BYTES = Number.MAX_SAFE_INTEGER;

/** What one run of either Studio backend dispatches. */
export interface StudioDispatch extends DispatchBase {
	/** Workspace runs only: stop on the first failing package. */
	bail: boolean;
	/**
	 * Experimental in-session Luau VM count, or `"auto"` for one per config.
	 */
	vmParallel: ParallelOption;
	/** Whether the jobs are workspace packages, run from the staged place. */
	workspace: boolean;
}

/** What a Studio run payload is built from. */
export interface RunPayloadRequest extends Pick<
	StudioDispatch,
	"bail" | "jobs" | "vmParallel" | "workspace"
> {
	/** The transport's own run timeout, in milliseconds. */
	runBudgetMs: number;
	/**
	 * Whether the plugin mounts the `jest.config` stubs at run time; false
	 * when the opened place has them built in.
	 */
	runtimeStubs: boolean;
}

interface ConfigRunPayload {
	configs: Array<StudioConfigEntry<IndexedJestArgv>>;
	/**
	 * The Luau coordinator's wait for its VM hosts must end inside this.
	 */
	runBudgetMs?: number;
	vmParallel?: number;
}

interface WorkspaceRunPayload {
	workspace: Pick<
		EmbeddedPayload<IndexedJestArgv>,
		"bail" | "entries" | "runBudgetMs" | "vmParallel"
	> &
		Required<Pick<EmbeddedPayload<IndexedJestArgv>, "resultBudgetBytes">>;
}

/**
 * Build the Run-mode runner payload shared by both Studio transports.
 *
 * @param request - Jobs, bail flag, run budget, and VM parallelism.
 * @returns The workspace payload, or the configs payload when the run is not a
 *   workspace run.
 * @throws {@link Error} When a workspace job has no package name.
 */
export function buildRunPayload({
	bail,
	jobs,
	runBudgetMs,
	runtimeStubs,
	vmParallel,
	workspace: isWorkspace,
}: RunPayloadRequest): RunPayload {
	if (isWorkspace) {
		const entries = jobs.map((job, jobIndex) => toMaterializerEntry(job, jobIndex));
		const workspace = { bail, entries, resultBudgetBytes: UNBOUNDED_RESULT_BUDGET_BYTES };
		const hostCount = resolveVmHostCount(vmParallel, entries.length);
		if (hostCount === undefined) {
			return { workspace };
		}

		return { workspace: { ...workspace, runBudgetMs, vmParallel: hostCount } };
	}

	const configs = jobs.map((job, jobIndex) => {
		return {
			config: indexArgv(job.argv, jobIndex),
			runtimeStubMounts: runtimeStubs ? (job.runtimeInjectionPaths ?? []) : [],
		};
	});
	const hostCount = resolveVmHostCount(vmParallel, configs.length);
	if (hostCount === undefined) {
		return { configs };
	}

	return { configs, runBudgetMs, vmParallel: hostCount };
}

/**
 * The raw results of a Studio run's envelope; each entry names its job.
 *
 * @param envelope - The decoded run envelope.
 * @param context - Backend name for errors, run game output, and job count.
 * @returns The raw results, and whether a bail skipped jobs.
 * @throws {@link Error} When the envelope deferred jobs.
 */
export function readPluginEntries(
	{ bailed, deferred: wasDeferred, entries, gameOutputScope }: DecodedEnvelope,
	{
		backendName,
		gameOutput,
		jobCount,
	}: { backendName: string; gameOutput: string | undefined; jobCount: number },
): Pick<BackendResult, "bailed" | "rawResults"> {
	if (wasDeferred) {
		throw new Error(
			`${backendName} deferred ${(jobCount - entries.length).toString()} of ${jobCount.toString()} jobs: the runner's result budget filled before they ran`,
		);
	}

	const rawResults = entries.map(({ jobIndex, ...entry }) => {
		return { entry, fallbackGameOutput: gameOutput, gameOutputScope, jobIndex };
	});

	return { bailed, rawResults };
}

function resolveVmHostCount(vmParallel: ParallelOption, configCount: number): number | undefined {
	if (vmParallel === undefined) {
		return undefined;
	}

	const requested = vmParallel === "auto" ? configCount : Math.floor(vmParallel);
	const hostCount = Math.min(requested, configCount, VM_HOST_POOL_SIZE);
	return hostCount > 1 ? hostCount : undefined;
}
