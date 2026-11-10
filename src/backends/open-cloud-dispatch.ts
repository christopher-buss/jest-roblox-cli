import type { ScriptResult } from "@isentinel/roblox-runner";

import {
	type MaterializerInput,
	toMaterializerEntry,
} from "../runner-payload/materializer-script.ts";
import type { DispatchBase, ParallelOption, RawBackendEntry } from "./interface.ts";
import type { JobBucket } from "./open-cloud-buckets.ts";
import { bucketJobs, bucketScript, resolveBucketCount } from "./open-cloud-buckets.ts";
import type { CollectedEntries, DispatchOutcome } from "./open-cloud-entries.ts";
import {
	aggregateEntriesByJob,
	parseStealingEnvelope,
	toDispatchOutcome,
} from "./open-cloud-entries.ts";
import type { VersionContext } from "./open-cloud-place-version.ts";
import type { StreamingHooks } from "./open-cloud-pool.ts";
import { drainDeferralsAsync, drainStealingPoolAsync } from "./open-cloud-pool.ts";
import type { PreparedStealing } from "./open-cloud-work-stealing.ts";

/** How an Open Cloud run splits its jobs across tasks. */
export type OpenCloudSharding =
	| { bail: boolean; kind: "deferrable"; parallel: ParallelOption }
	| {
			bail: boolean;
			kind: "work-stealing";
			onPackageResult?: StreamingHooks["onPackageResult"] | undefined;
			parallel: ParallelOption;
	  }
	| { kind: "static"; parallel: ParallelOption };

/** What a work-stealing run asks the backend to set up. */
export interface StealingRequest {
	/** Whether to stop on the first failing package. */
	bail: boolean;
	/** One materializer input per job. */
	inputs: Array<MaterializerInput>;
	/** Receives each streamed package result, if set. */
	onPackageResult?: StreamingHooks["onPackageResult"] | undefined;
	/** Deadline Roblox gives every task of the run, in milliseconds. */
	taskTimeout: number;
}

/** What one Open Cloud run dispatches. */
export interface OpenCloudDispatch extends DispatchBase {
	/** How the jobs split across tasks. */
	sharding: OpenCloudSharding;
}

/** One Open Cloud task to run. */
export interface TaskRequest {
	/** Luau source the task runs. */
	script: string;
	/** Task timeout, in milliseconds. */
	timeout: number;
	/** Place version the task runs against. */
	version: VersionContext;
}

type DispatchRequest = OpenCloudDispatch & {
	/** Runs one task. */
	readonly executeAsync: (request: TaskRequest) => Promise<ScriptResult>;
	/** Sets up the queue and script; `undefined` falls back to deferrable. */
	readonly prepareStealingAsync: (
		request: StealingRequest,
	) => Promise<PreparedStealing | undefined>;
	/** Place version every task runs against. */
	readonly version: VersionContext;
};

/**
 * Run the jobs in the shape their sharding names.
 *
 * @param request - Jobs, sharding, and the task runner.
 * @returns The collected entries of the run.
 */
export async function dispatchJobsAsync(request: DispatchRequest): Promise<DispatchOutcome> {
	const { sharding } = request;
	if (sharding.kind === "work-stealing") {
		return runWorkStealingAsync(request, sharding);
	}

	if (sharding.kind === "deferrable") {
		return runDeferrableAsync(request, sharding);
	}

	return runStaticBucketsAsync(request, sharding.parallel);
}

function runScriptWith({
	executeAsync,
	runSettings,
	version,
}: DispatchRequest): (script: string) => Promise<ScriptResult> {
	return async (script) => executeAsync({ script, timeout: runSettings.timeout, version });
}

async function runDeferrableAsync(
	request: DispatchRequest,
	{ bail, parallel }: Extract<OpenCloudSharding, { kind: "deferrable" }>,
): Promise<DispatchOutcome> {
	const runScript = runScriptWith(request);
	const drained = await Promise.all(
		bucketJobs(request.jobs, parallel).map(async (bucket) => {
			const entries = bucket.map(({ job, jobIndex }) => toMaterializerEntry(job, jobIndex));
			return drainDeferralsAsync({ bail, entries, runScript });
		}),
	);

	const collected: CollectedEntries = new Map();
	for (const bucket of drained) {
		for (const [jobIndex, entry] of bucket.collected) {
			collected.set(jobIndex, entry);
		}
	}

	return toDispatchOutcome(
		drained.some((bucket) => bucket.bailed),
		collected,
	);
}

async function runBucketAsync(
	bucket: JobBucket,
	runScript: (script: string) => Promise<ScriptResult>,
): Promise<Array<RawBackendEntry>> {
	const { entries, gameOutput } = parseStealingEnvelope(await runScript(bucketScript(bucket)));
	return entries.map(({ jobIndex, ...entry }) => {
		return { entry, fallbackGameOutput: gameOutput, jobIndex };
	});
}

async function runStaticBucketsAsync(
	request: DispatchRequest,
	parallel: ParallelOption,
): Promise<DispatchOutcome> {
	const runScript = runScriptWith(request);
	const bucketResults = await Promise.all(
		bucketJobs(request.jobs, parallel).map(async (bucket) => runBucketAsync(bucket, runScript)),
	);

	return { rawResults: bucketResults.flat() };
}

async function runWorkStealingAsync(
	request: DispatchRequest,
	{ bail, onPackageResult, parallel }: Extract<OpenCloudSharding, { kind: "work-stealing" }>,
): Promise<DispatchOutcome> {
	const { jobs } = request;
	const prepared = await request.prepareStealingAsync({
		bail,
		inputs: jobs.map((job, jobIndex) => toMaterializerEntry(job, jobIndex)),
		onPackageResult,
		taskTimeout: request.runSettings.timeout,
	});
	if (prepared === undefined) {
		return runDeferrableAsync(request, { bail, kind: "deferrable", parallel });
	}

	const { script, streaming } = prepared;
	const runScript = runScriptWith(request);
	const taskResults = await drainStealingPoolAsync({
		requiredKeyCount: jobs.length,
		runTask: async () => runScript(script),
		streaming,
		taskCount: resolveBucketCount(parallel, jobs.length),
	});

	// Parse only after the pool settles: the pool swallows per-task throws.
	const taskEnvelopes = taskResults.map(parseStealingEnvelope);
	return toDispatchOutcome(
		taskEnvelopes.some((envelope) => envelope.bailed),
		aggregateEntriesByJob(taskEnvelopes),
	);
}
