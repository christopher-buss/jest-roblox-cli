import type { ScriptResult } from "@isentinel/roblox-runner";

import type { ResolvedConfig } from "../config/schema.ts";
import { decodeEnvelope } from "./envelope.ts";
import type { BackendOptions, ProjectJob, RawBackendEntry } from "./interface.ts";
import type { JobBucket } from "./open-cloud-buckets.ts";
import { bucketJobs, bucketScript, resolveBucketCount } from "./open-cloud-buckets.ts";
import type { CollectedEntry, DispatchOutcome } from "./open-cloud-entries.ts";
import {
	addEntriesToMap,
	aggregateEntriesByKey,
	collectStealingResults,
	entryLookupKey,
	parseStealingEnvelope,
} from "./open-cloud-entries.ts";
import type { VersionContext } from "./open-cloud-place-version.ts";
import { drainStealingPoolAsync } from "./open-cloud-pool.ts";

/** Backend options plus what one Open Cloud run needs to dispatch its jobs. */
export type DispatchRequest = BackendOptions & {
	/** Runs one task. */
	readonly executeAsync: ExecuteTask;
	/** Config of the first job. */
	readonly primaryConfig: ResolvedConfig;
	/** Place version every task runs against. */
	readonly version: VersionContext;
};

/** Runs one Luau task in Open Cloud and resolves with its result. */
type ExecuteTask = (request: {
	/** Luau source the task runs. */
	script: string;
	/** Task timeout, in milliseconds. */
	timeout: number;
	/** Place version the task runs against. */
	version: VersionContext;
}) => Promise<ScriptResult>;

/**
 * Pick the execution shape for one run.
 *
 * Every shape but the first buckets the jobs; what differs is where a
 * bucket's script comes from and whether the run can answer a deferral.
 * Work-stealing skips bucketing entirely and fans one script out over a
 * shared queue. A workspace run without the queue takes each bucket's
 * script from the factory, which is also what lets it re-send whatever a
 * task defers. Everything else generates a bucket's script from its jobs
 * and has no deferral to answer.
 *
 * @param request - Jobs, run options, and the task runner.
 * @returns The collected entries of the run.
 */
export async function dispatchJobsAsync(request: DispatchRequest): Promise<DispatchOutcome> {
	if (request.workStealing === true && request.scriptOverride !== undefined) {
		return runWorkStealingAsync({ ...request, scriptOverride: request.scriptOverride });
	}

	if (request.scriptFactory !== undefined) {
		return runDeferrableAsync({ ...request, scriptFactory: request.scriptFactory });
	}

	return runStaticBucketsAsync(request);
}

/**
 * Run one bucket's jobs, re-sending whatever its task left behind, and hand
 * back what came in plus whether the bucket bailed.
 *
 * @param options - The bucket's jobs, script factory, and task runner.
 * @returns Collected entries by key, and whether any task bailed.
 */
async function drainDeferralsAsync({
	executeAsync,
	jobs,
	scriptFactory,
	timeout,
	version,
}: {
	executeAsync: ExecuteTask;
	jobs: Array<ProjectJob>;
	scriptFactory: (jobs: ReadonlyArray<ProjectJob>) => string;
	timeout: number;
	version: VersionContext;
}): Promise<{ bailed: boolean; collected: Map<string, CollectedEntry> }> {
	const collected = new Map<string, CollectedEntry>();
	let remaining: Array<ProjectJob> = jobs;
	let script = scriptFactory(jobs);
	let hasBailed = false;

	// One attempt per job is the ceiling: a task always runs at least one
	// entry, so it cannot take more rounds than there are jobs.
	for (const _attempt of jobs) {
		const envelope = parseStealingEnvelope(await executeAsync({ script, timeout, version }));
		addEntriesToMap({
			entries: envelope.entries,
			entryByKey: collected,
			gameOutput: envelope.gameOutput,
		});
		hasBailed ||= envelope.bailed;
		if (!envelope.deferred) {
			break;
		}

		// Against `remaining`, not `jobs`: a round that covers nothing new
		// stops the loop rather than spending the rest of that budget on
		// tasks that cannot make progress.
		const outstanding = remaining.filter((job) => {
			return !collected.has(entryLookupKey(job.pkg ?? job.displayName, job.displayName));
		});
		if (outstanding.length === 0 || outstanding.length === remaining.length) {
			break;
		}

		remaining = outstanding;
		script = scriptFactory(remaining);
	}

	return { bailed: hasBailed, collected };
}

/**
 * Bucket a workspace run and drain each bucket's deferrals concurrently.
 *
 * There is no queue on this path, so a task that fills its return-envelope
 * budget cannot hand the rest to a sibling; the backend answers the
 * deferral itself. The factory is what makes the buckets possible — it
 * builds a script from any subset of the entries, so `--parallel N` buys
 * the same static shard split multi mode gets, and every bucket keeps its
 * own chain of re-sends.
 *
 * Buckets hold disjoint jobs, so the per-bucket maps merge with no winner
 * to pick: no key reaches two of them.
 *
 * @param request - Dispatch request with a script factory.
 * @returns The merged entries of every bucket.
 */
async function runDeferrableAsync({
	executeAsync,
	jobs,
	parallel,
	primaryConfig,
	scriptFactory,
	version,
}: DispatchRequest & {
	readonly scriptFactory: (jobs: ReadonlyArray<ProjectJob>) => string;
}): Promise<DispatchOutcome> {
	const drained = await Promise.all(
		bucketJobs(jobs, parallel).map(async (bucket) => {
			return drainDeferralsAsync({
				executeAsync,
				jobs: bucket.jobs,
				scriptFactory,
				timeout: primaryConfig.timeout,
				version,
			});
		}),
	);

	const entryByKey = new Map<string, CollectedEntry>();
	for (const bucket of drained) {
		for (const [key, entry] of bucket.collected) {
			entryByKey.set(key, entry);
		}
	}

	return collectStealingResults({
		bailed: drained.some((bucket) => bucket.bailed),
		entryByKey,
		jobs,
	});
}

async function runBucketAsync({
	bucket: { indices, jobs },
	executeAsync,
	scriptOverride,
	version,
}: {
	bucket: JobBucket;
	executeAsync: ExecuteTask;
	scriptOverride: string | undefined;
	version: VersionContext;
}): Promise<{ indices: Array<number>; rawResults: Array<RawBackendEntry> }> {
	// A bucket is only created for at least one job, so jobs[0] is defined.
	// oxlint-disable-next-line typescript/no-non-null-assertion -- bucket non-empty
	const primary = jobs[0]!;
	const script = scriptOverride ?? bucketScript(jobs);
	const scriptResult = await executeAsync({
		script,
		timeout: primary.config.timeout,
		version,
	});

	const jestOutput = scriptResult.outputs[0];
	if (jestOutput === undefined) {
		throw new Error(`No test results in output. Got: ${JSON.stringify(scriptResult.outputs)}`);
	}

	const fallbackGameOutput = scriptResult.outputs[1];
	const { entries } = decodeEnvelope(jestOutput);
	if (entries.length !== jobs.length) {
		throw new Error(
			`Open Cloud backend returned ${entries.length.toString()} entries but bucket had ${jobs.length.toString()} jobs`,
		);
	}

	const rawResults: Array<RawBackendEntry> = entries.map((entry) => {
		return { entry, fallbackGameOutput };
	});

	return { indices, rawResults };
}

async function runStaticBucketsAsync({
	executeAsync,
	jobs,
	parallel,
	scriptOverride,
	version,
}: DispatchRequest): Promise<DispatchOutcome> {
	const buckets = bucketJobs(jobs, parallel);
	const bucketResults = await Promise.all(
		buckets.map(async (bucket) => {
			return runBucketAsync({ bucket, executeAsync, scriptOverride, version });
		}),
	);

	// Flatten bucket results in original job order via the indices recorded
	// at bucketing time. indices and rawResults always share the same length
	// because runBucket asserts that invariant before returning.
	const flattened: Array<RawBackendEntry> = Array.from({ length: jobs.length });
	for (const { indices, rawResults } of bucketResults) {
		for (const [positionInBucket, originalIndex] of indices.entries()) {
			// oxlint-disable-next-line typescript/no-non-null-assertion -- length invariant
			flattened[originalIndex] = rawResults[positionInBucket]!;
		}
	}

	return { rawResults: flattened };
}

async function runWorkStealingAsync({
	executeAsync,
	jobs,
	parallel,
	primaryConfig,
	scriptOverride,
	streaming,
	version,
}: DispatchRequest & { scriptOverride: string }): Promise<DispatchOutcome> {
	const taskResults = await drainStealingPoolAsync({
		requiredKeyCount: jobs.length,
		runTask: async () => {
			return executeAsync({
				script: scriptOverride,
				timeout: primaryConfig.timeout,
				version,
			});
		},
		streaming,
		taskCount: resolveBucketCount(parallel, jobs.length),
	});

	// Parse after the pool settles so a task that returned no usable output
	// throws here, in the normal flow, rather than being swallowed by the
	// pool's per-task error handling.
	const taskEnvelopes = taskResults.map(parseStealingEnvelope);
	return collectStealingResults({
		bailed: taskEnvelopes.some((envelope) => envelope.bailed),
		entryByKey: aggregateEntriesByKey(taskEnvelopes),
		jobs,
	});
}
