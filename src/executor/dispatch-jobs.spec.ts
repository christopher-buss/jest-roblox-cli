import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it, vi } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { NOOP_PROGRESS } from "#test/mocks/noop-progress.ts";
import { projectJob } from "#test/mocks/project-job.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { Backend } from "../backends/dispatch-request.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import type { TsconfigReader } from "../tsconfig/tsconfig-mappings.ts";
import { dispatchJobsAsync } from "./dispatch-jobs.ts";
import type { ConfiguredJob } from "./executor-types.ts";
import type { ExecuteJobs, JobResult } from "./executor.ts";

describe(dispatchJobsAsync, () => {
	it("should run the built jobs once, in a profiled phase, and return what ran", async () => {
		expect.assertions(3);

		const config = createResolvedConfig();
		const jobs: Array<ConfiguredJob> = [
			projectJob({ config, displayName: "a", testFiles: ["a.spec.ts"] }),
			projectJob({ config, displayName: "b", testFiles: ["b.spec.ts"] }),
		];
		const result = fromAny<JobResult, unknown>({ exitCode: 0, jobIndex: 1 });
		const runProjects = vi.fn<ExecuteJobs>(async () => {
			return { backendTiming: { executionMs: 1 }, results: [result] };
		});
		const profileAsync = vi.fn<TimingCollector["profileAsync"]>(async (_name, run) => run());
		const timing = fromAny<TimingCollector, unknown>({ profileAsync });
		const backend = fromAny<Backend, unknown>({ kind: "studio" });
		const { fileSystem } = createMemoryFileSystem();
		const tsconfigReader = vi.fn<TsconfigReader>();
		vi.spyOn(Date, "now").mockReturnValue(123);

		const dispatched = await dispatchJobsAsync({
			backend,
			dispatch: { bail: true, parallel: 2, workspace: {} },
			fileSystem,
			jobs,
			progress: NOOP_PROGRESS,
			runProjects,
			runSettings: config,
			timing,
			tsconfigCache: new Map(),
			tsconfigReader,
		});

		expect(dispatched).toStrictEqual({ results: [result] });
		expect(runProjects).toHaveBeenCalledExactlyOnceWith({
			backend,
			bail: true,
			fileSystem,
			jobs,
			parallel: 2,
			progress: NOOP_PROGRESS,
			runSettings: config,
			startTime: 123,
			timing,
			tsconfigCache: new Map(),
			tsconfigReader,
			workspace: {},
		});
		expect(profileAsync).toHaveBeenCalledExactlyOnceWith("runProjects", expect.any(Function));
	});
});
