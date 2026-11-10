import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it, vi } from "vitest";

import { NOOP_PROGRESS } from "#test/mocks/noop-progress.ts";
import { projectJob } from "#test/mocks/project-job.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import { type Backend, dispatchAsync } from "./dispatch-request.ts";
import type { BackendResult, ProjectJob } from "./interface.ts";
import type { StreamingHooks } from "./open-cloud-pool.ts";

const SETTINGS = createResolvedConfig({ rootDir: "/run" });

const RESULT: BackendResult = { rawResults: [], timing: { executionMs: 0 } };

function job(displayName: string, rootDirectory = "/repo"): ProjectJob {
	return projectJob({
		config: createResolvedConfig({ rootDir: rootDirectory }),
		displayName,
		testFiles: [`${displayName}/test.spec.ts`],
	});
}

function capture(kind: Backend["kind"]) {
	const runTestsAsync = vi.fn<(request: object) => Promise<BackendResult>>(async () => RESULT);
	const backend = fromAny<Backend, unknown>({ kind, runTestsAsync });
	return { backend, runTestsAsync };
}

describe(dispatchAsync, () => {
	it("should reject a plan with no jobs", async () => {
		expect.assertions(1);

		const { backend } = capture("studio");

		await expect(dispatchAsync(backend, { jobs: [], runSettings: SETTINGS })).rejects.toThrow(
			"The studio backend got no jobs to run",
		);
	});

	it("should hand Open Cloud static buckets and the run settings", async () => {
		expect.assertions(2);

		const { backend, runTestsAsync } = capture("open-cloud");
		const jobs = [job("alpha", "/first"), job("beta", "/second")];

		const result = await dispatchAsync(backend, {
			jobs,
			parallel: 2,
			progress: NOOP_PROGRESS,
			runSettings: SETTINGS,
			vmParallel: 3,
		});

		expect(result).toBe(RESULT);
		expect(runTestsAsync).toHaveBeenCalledExactlyOnceWith({
			jobs,
			progress: NOOP_PROGRESS,
			runSettings: SETTINGS,
			sharding: { kind: "static", parallel: 2 },
		});
	});

	it("should ask Open Cloud to work-steal a sharded workspace run", async () => {
		expect.assertions(1);

		const { backend, runTestsAsync } = capture("open-cloud");
		const onPackageResult = vi.fn<StreamingHooks["onPackageResult"]>();

		await dispatchAsync(backend, {
			bail: true,
			jobs: [job("alpha")],
			parallel: "auto",
			runSettings: SETTINGS,
			workspace: { onPackageResult },
		});

		expect(runTestsAsync.mock.calls[0]![0]).toHaveProperty("sharding", {
			bail: true,
			kind: "work-stealing",
			onPackageResult,
			parallel: "auto",
		});
	});

	it("should not bail a work-stealing Open Cloud run the plan did not ask to bail", async () => {
		expect.assertions(1);

		const { backend, runTestsAsync } = capture("open-cloud");

		await dispatchAsync(backend, {
			jobs: [job("alpha")],
			parallel: 2,
			runSettings: SETTINGS,
			workspace: {},
		});

		expect(runTestsAsync.mock.calls[0]![0]).toHaveProperty("sharding", {
			bail: false,
			kind: "work-stealing",
			onPackageResult: undefined,
			parallel: 2,
		});
	});

	it("should keep a workspace run on one Open Cloud session deferrable", async () => {
		expect.assertions(1);

		const { backend, runTestsAsync } = capture("open-cloud");

		await dispatchAsync(backend, {
			bail: true,
			jobs: [job("alpha")],
			parallel: 1,
			runSettings: SETTINGS,
			workspace: {},
		});

		expect(runTestsAsync.mock.calls[0]![0]).toHaveProperty("sharding", {
			bail: true,
			kind: "deferrable",
			parallel: 1,
		});
	});

	it("should not bail a deferrable Open Cloud run the plan did not ask to bail", async () => {
		expect.assertions(1);

		const { backend, runTestsAsync } = capture("open-cloud");

		await dispatchAsync(backend, {
			jobs: [job("alpha")],
			runSettings: SETTINGS,
			workspace: {},
		});

		expect(runTestsAsync.mock.calls[0]![0]).toHaveProperty("sharding", {
			bail: false,
			kind: "deferrable",
			parallel: undefined,
		});
	});

	it.for<[Backend["kind"]]>([["studio"], ["studio-cli"]])(
		"should hand %s the bail flag, the VM count and the run shape",
		async ([kind]) => {
			expect.assertions(2);

			const first = capture(kind);
			const jobs = [job("alpha")];
			await dispatchAsync(first.backend, {
				jobs,
				parallel: 2,
				runSettings: SETTINGS,
				vmParallel: "auto",
			});
			const second = capture(kind);
			await dispatchAsync(second.backend, {
				bail: true,
				jobs,
				runSettings: SETTINGS,
				workspace: {},
			});

			expect(first.runTestsAsync).toHaveBeenCalledExactlyOnceWith({
				bail: false,
				jobs,
				progress: undefined,
				runSettings: SETTINGS,
				vmParallel: "auto",
				workspace: false,
			});
			expect(second.runTestsAsync.mock.calls[0]![0]).toMatchObject({
				bail: true,
				workspace: true,
			});
		},
	);
});
