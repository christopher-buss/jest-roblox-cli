import type { RunProgress } from "../progress/run-progress.ts";
import {
	type BackendOf,
	type BackendResult,
	type DispatchBase,
	isShardedParallel,
	type ParallelOption,
	type ProjectJob,
	type RunSettings,
} from "./interface.ts";
import type { OpenCloudDispatch, OpenCloudSharding } from "./open-cloud-dispatch.ts";
import type { StreamingHooks } from "./open-cloud-pool.ts";
import type { StudioDispatch } from "./plugin-payload.ts";

/** A backend of any kind, each taking its own dispatch request. */
export type Backend =
	| BackendOf<"open-cloud", OpenCloudDispatch>
	| BackendOf<"studio", StudioDispatch>
	| BackendOf<"studio-cli", StudioDispatch>;

/** What the run planned to dispatch, before it is fitted to one backend. */
export interface DispatchPlan {
	/** Workspace runs: stop on the first failing package. */
	bail?: boolean | undefined;
	/** Jobs to run, in order. */
	jobs: Array<ProjectJob>;
	/** Open Cloud session count. */
	parallel?: ParallelOption;
	/** Receives the stages only the backend can see. */
	progress?: RunProgress | undefined;
	/** Run-wide settings, the same for every job. */
	runSettings: RunSettings;
	/** Luau VM count inside one Studio session. */
	vmParallel?: ParallelOption;
	/** Set for a workspace run. */
	workspace?: undefined | WorkspaceDispatch;
}

/**
 * How the run spreads its jobs: bail, sessions, VMs and the workspace shape.
 */
export type DispatchKnobs = Pick<DispatchPlan, "bail" | "parallel" | "vmParallel" | "workspace">;

/** What a workspace run hands the backend. */
interface WorkspaceDispatch {
	/** Receives each package result an Open Cloud work-stealing run streams. */
	onPackageResult?: StreamingHooks["onPackageResult"] | undefined;
}

/**
 * Fit the plan to the backend's own request type and run it.
 *
 * @param backend - Backend that runs the jobs.
 * @param plan - What the run planned to dispatch.
 * @returns Raw entries and timing of the run.
 * @rejects When the plan has no jobs.
 */
export async function dispatchAsync(backend: Backend, plan: DispatchPlan): Promise<BackendResult> {
	const [first, ...rest] = plan.jobs;
	if (first === undefined) {
		throw new Error(`The ${backend.kind} backend got no jobs to run`);
	}

	const base: DispatchBase = {
		jobs: [first, ...rest],
		progress: plan.progress,
		runSettings: plan.runSettings,
	};
	if (backend.kind === "open-cloud") {
		return backend.runTestsAsync({ ...base, sharding: openCloudSharding(plan) });
	}

	return backend.runTestsAsync({
		...base,
		bail: plan.bail ?? false,
		vmParallel: plan.vmParallel,
		workspace: plan.workspace !== undefined,
	});
}

function openCloudSharding({ bail = false, parallel, workspace }: DispatchPlan): OpenCloudSharding {
	if (workspace === undefined) {
		return { kind: "static", parallel };
	}

	if (!isShardedParallel(parallel)) {
		return { bail, kind: "deferrable", parallel };
	}

	return {
		bail,
		kind: "work-stealing",
		onPackageResult: workspace.onPackageResult,
		parallel,
	};
}
