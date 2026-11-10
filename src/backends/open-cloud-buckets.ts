import { indexArgv } from "../runner-payload/jest-argv.ts";
import { generateTestScript } from "../runner-payload/test-script.ts";
import type { ParallelOption, ProjectJob } from "./interface.ts";

const PARALLEL_AUTO_CAP = 3;

/** Jobs one task runs, in request order. */
export type JobBucket = Array<BucketJob>;

/** One job of a bucket, with its index in the request. */
interface BucketJob {
	/** The job. */
	job: ProjectJob;
	/** Index of the job in the request. */
	jobIndex: number;
}

/**
 * The script one bucket of jobs runs.
 *
 * @param bucket - Jobs the script runs, in order.
 * @returns Luau source that runs the jobs.
 */
export function bucketScript(bucket: JobBucket): string {
	return generateTestScript(bucket.map(({ job, jobIndex }) => indexArgv(job.argv, jobIndex)));
}

/**
 * Resolve how many buckets a run splits into.
 *
 * @param parallel - Requested shard count, `"auto"`, or unset for one.
 * @param jobCount - Number of jobs in the run.
 * @returns The bucket count, never more than the job count.
 * @throws {@link Error} When `parallel` is a number below 1.
 */
export function resolveBucketCount(parallel: ParallelOption, jobCount: number): number {
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
export function bucketJobs(jobs: Array<ProjectJob>, parallel: ParallelOption): Array<JobBucket> {
	const bucketCount = resolveBucketCount(parallel, jobs.length);
	const buckets = Array.from({ length: bucketCount }, (): JobBucket => []);

	for (const [jobIndex, job] of jobs.entries()) {
		// oxlint-disable-next-line typescript/no-non-null-assertion -- index always valid
		buckets[jobIndex % bucketCount]!.push({ job, jobIndex });
	}

	return buckets;
}
