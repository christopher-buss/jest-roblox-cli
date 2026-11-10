import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it } from "vitest";

import { fakeTimingCollector } from "#test/mocks/fake-timing-collector.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { Backend } from "../backends/dispatch-request.ts";
import type { ConfiguredJob } from "./executor-types.ts";
import { executeJobsAsync } from "./executor.ts";

function makeJob(displayName: string): ConfiguredJob {
	return fromAny({ config: createResolvedConfig(), displayName, testFiles: [] });
}

function backendAnswering(jobIndices: Array<number>): Backend {
	return fromAny({
		kind: "open-cloud",
		runTestsAsync: async () => {
			return {
				rawResults: jobIndices.map((jobIndex) => ({ jobIndex })),
				timing: { executionMs: 0, uploadMs: 0 },
			};
		},
	});
}

describe(executeJobsAsync, () => {
	it("should refuse a backend result that names a job twice", async () => {
		expect.assertions(1);

		await expect(
			executeJobsAsync({
				backend: backendAnswering([0, 0]),
				fileSystem: createMemoryFileSystem().fileSystem,
				jobs: [makeJob("alpha")],
				runSettings: createResolvedConfig(),
				startTime: 0,
				timing: { ...fakeTimingCollector(), enabled: false },
				tsconfigCache: new Map(),
				tsconfigReader: fromAny({}),
			}),
		).rejects.toThrow("Backend returned two results for job 0 (alpha)");
	});
});
