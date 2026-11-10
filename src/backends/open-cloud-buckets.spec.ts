import { describe, expect, it } from "vitest";

import { projectJob } from "#test/mocks/project-job.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { ProjectJob } from "./interface.ts";
import { bucketJobs, bucketScript, resolveBucketCount } from "./open-cloud-buckets.ts";

function job(displayName: string): ProjectJob {
	return projectJob({
		config: { ...createResolvedConfig(), testNamePattern: `pattern-${displayName}` },
		displayName,
		testFiles: [`${displayName}/test.spec.ts`],
	});
}

function jobs(count: number): Array<ProjectJob> {
	return Array.from({ length: count }, (_, index) => job(`p${index.toString()}`));
}

describe(resolveBucketCount, () => {
	it.for([
		{ expected: 1, jobCount: 5, parallel: undefined },
		{ expected: 3, jobCount: 5, parallel: "auto" },
		{ expected: 2, jobCount: 2, parallel: "auto" },
		{ expected: 2, jobCount: 2, parallel: 10 },
		{ expected: 2, jobCount: 5, parallel: 2.7 },
	] as const)(
		"should give $expected buckets for $jobCount jobs at --parallel $parallel",
		({ expected, jobCount, parallel }) => {
			expect.assertions(1);

			expect(resolveBucketCount(parallel, jobCount)).toBe(expected);
		},
	);

	it("should throw when --parallel is less than 1", () => {
		expect.assertions(1);

		expect(() => resolveBucketCount(0, 1)).toThrow("--parallel must be >= 1, got 0");
	});
});

describe(bucketJobs, () => {
	it("should round-robin 10 jobs into buckets of 4/3/3 and record each job's index", () => {
		expect.assertions(1);

		const buckets = bucketJobs(jobs(10), 3);

		expect(buckets.map((bucket) => bucket.map(({ jobIndex }) => jobIndex))).toStrictEqual([
			[0, 3, 6, 9],
			[1, 4, 7],
			[2, 5, 8],
		]);
	});
});

describe(bucketScript, () => {
	it("should carry every job's config and request index in the script", () => {
		expect.assertions(4);

		const script = bucketScript([
			{ job: job("alpha"), jobIndex: 4 },
			{ job: job("beta"), jobIndex: 7 },
		]);

		expect(script).toContain('"testNamePattern":"pattern-alpha"');
		expect(script).toContain('"testNamePattern":"pattern-beta"');
		expect(script).toContain('"runnerJobIndex":4');
		expect(script).toContain('"runnerJobIndex":7');
	});
});
