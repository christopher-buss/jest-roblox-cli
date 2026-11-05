import type { JestArgvInput } from "../test-script.ts";
import { generateTestScript } from "../test-script.ts";
import type { BackendOptions, ProjectJob } from "./interface.ts";

const PARALLEL_AUTO_CAP = 3;

/** Jobs one task runs, with their positions in the request. */
export interface JobBucket {
	/** Request index of each job, in bucket order. */
	indices: Array<number>;
	/** Jobs the bucket runs. */
	jobs: Array<ProjectJob>;
}

/**
 * The script one bucket of jobs runs.
 *
 * @param jobs - Jobs the script runs, in order.
 * @returns Luau source that runs the jobs.
 */
export function bucketScript(jobs: Array<ProjectJob>): string {
	const inputs: Array<JestArgvInput> = jobs.map((job) => {
		return { config: job.config, testFiles: job.testFiles };
	});
	return generateTestScript(inputs);
}

/**
 * Resolve how many buckets a run splits into.
 *
 * @param parallel - Requested shard count, `"auto"`, or unset for one.
 * @param jobCount - Number of jobs in the run.
 * @returns The bucket count, never more than the job count.
 * @throws {@link Error} When `parallel` is a number below 1.
 */
export function resolveBucketCount(parallel: BackendOptions["parallel"], jobCount: number): number {
	if (parallel === undefined) {
		return 1;
	}

	if (parallel === "auto") {
		return Math.min(jobCount, PARALLEL_AUTO_CAP);
	}

	if (parallel < 1) {
		throw new Error(`--parallel must be >= 1, got ${parallel.toString()}`);
	}

	return Math.min(Math.floor(parallel), jobCount);
}

/**
 * Split jobs round-robin into buckets, keeping request order in each.
 *
 * @param jobs - Jobs of the run.
 * @param parallel - Requested shard count, `"auto"`, or unset for one.
 * @returns One bucket per shard.
 * @throws {@link Error} When `parallel` is a number below 1.
 */
export function bucketJobs(
	jobs: Array<ProjectJob>,
	parallel: BackendOptions["parallel"],
): Array<JobBucket> {
	const bucketCount = resolveBucketCount(parallel, jobs.length);
	const buckets = Array.from({ length: bucketCount }, (): JobBucket => {
		return {
			indices: [],
			jobs: [],
		};
	});

	// Round-robin assignment: job[i] goes to bucket i % bucketCount. Preserves
	// input order within each bucket so per-bucket results flatten back in the
	// original request order via the recorded indices. Smart LPT bucketing is
	// future work (F1 in the plan).
	for (const [originalIndex, job] of jobs.entries()) {
		// oxlint-disable-next-line typescript/no-non-null-assertion -- index always valid
		const bucket = buckets[originalIndex % bucketCount]!;
		bucket.indices.push(originalIndex);
		bucket.jobs.push(job);
	}

	return buckets;
}
