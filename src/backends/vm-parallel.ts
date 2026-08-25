import type { ParallelOption } from "./interface.ts";

/**
 * How many `Actor` hosts the Studio plugin ships.
 *
 * A build-time property of `plugin/plugin.project.json`, not a runtime one:
 * each host is a declared `Actor` holding its own copy of the runner tree, and
 * Studio only runs plugin scripts that were there when the plugin loaded.
 * Keep this in step with the `vmHosts` entries in that file — the plugin
 * clamps to the hosts it actually finds, so the two disagreeing costs
 * parallelism rather than correctness.
 *
 * A tuning surface: more hosts buy concurrency for wide suites at ~62 KB of
 * plugin size each.
 */
export const VM_HOST_POOL_SIZE = 4;

/**
 * How many Luau VMs the Studio plugin should actually start for a run of
 * `configCount` projects, or undefined when the run stays sequential.
 *
 * Never more VMs than there are configs to put in them, never more than the
 * hosts the plugin ships, and never fewer than two: one VM *is* the sequential
 * path, and taking the parallel branch for it would trade per-project game
 * output for a batch-scoped capture with no concurrency to show for it.
 *
 * Read by the payload builder — which tells the plugin what to do — and by the
 * output layer, which labels the game output for what actually happened. Both
 * must decide the same way, or a run that fell back to sequential would still
 * write its output under a batch label (and lose every project's but the
 * first).
 *
 * The plugin clamps again against the hosts it ships, so this is a request
 * rather than a promise.
 */
export function resolveVmHostCount(
	vmParallel: ParallelOption,
	configCount: number,
): number | undefined {
	if (vmParallel === undefined) {
		return undefined;
	}

	const requested = vmParallel === "auto" ? configCount : Math.floor(vmParallel);
	const hostCount = Math.min(requested, configCount, VM_HOST_POOL_SIZE);
	return hostCount > 1 ? hostCount : undefined;
}
