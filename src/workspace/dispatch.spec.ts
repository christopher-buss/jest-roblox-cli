import { fromAny } from "@total-typescript/shoehorn";

import process from "node:process";
import { assert, describe, expect, it, onTestFinished, vi } from "vitest";

import { type Backend, isShardedParallel, type ProjectJob } from "../backends/interface.ts";
import {
	buildProjectJob,
	type ExecuteResult,
	runProjectsAsync,
	type RunProjectsResult,
} from "../executor.ts";
import type { TsconfigMappingCache } from "../executor/tsconfig-mappings.ts";
import { prepareWorkStealingQueueAsync } from "../memory-store/work-stealing.ts";
import {
	generateMaterializerScript,
	generateWorkStealingScript,
	type MaterializerInput,
} from "../staging/test-script-staged.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import {
	buildWorkspaceJobs,
	prepareWorkspaceDispatchAsync,
	runDispatchedProjectsAsync,
	type WorkspaceJob,
} from "./dispatch.ts";
import type { PendingEntry } from "./test-selection.ts";

vi.mock(import("../backends/interface.ts"));
vi.mock(import("../executor.ts"));
vi.mock(import("../memory-store/work-stealing.ts"));
vi.mock(import("../staging/test-script-staged.ts"));

function makeJob(
	packageName: string,
	displayName: string,
	config: { projectTimeout?: number; timeout?: number } = {},
): WorkspaceJob {
	return fromAny({
		config: {
			projectTimeout: 60_000,
			rootDir: `/repo/${packageName}`,
			timeout: 300_000,
			...config,
		},
		displayName,
		pkg: packageName,
		testFiles: [`${displayName}.spec.ts`],
	});
}

function materializerInput(job: WorkspaceJob): MaterializerInput {
	return {
		config: job.config,
		pkg: job.pkg,
		project: job.displayName,
		testFiles: job.testFiles,
	};
}

function createTiming(): TimingCollector {
	return fromAny({
		profileAsync: vi.fn<(name: string, action: () => Promise<unknown>) => Promise<unknown>>(
			async (_name, action) => action(),
		),
	});
}

describe(runDispatchedProjectsAsync, () => {
	it("should run the exact prepared jobs and return both result arrays", async () => {
		expect.assertions(3);

		const jobs = [makeJob("pkg-a", "unit")];
		const timing = createTiming();
		const backend = fromAny<Backend, unknown>({ kind: "open-cloud" });
		const tsconfigCache: TsconfigMappingCache = new Map();
		const executeResult = fromAny<ExecuteResult, unknown>({ success: true });
		vi.mocked(runProjectsAsync).mockResolvedValue(
			fromAny<RunProjectsResult, unknown>({
				backendTiming: {},
				ranProjectIndices: [0],
				results: [executeResult],
			}),
		);
		const scriptFactory = vi.fn<(jobs: ReadonlyArray<ProjectJob>) => string>(
			() => "retry-script",
		);

		const result = await runDispatchedProjectsAsync({
			backend,
			dispatchSpec: { parallel: 2, scriptFactory, scriptOverride: "initial-script" },
			jobs,
			startTime: 123,
			timing,
			tsconfigCache,
			version: "1.2.3",
		});

		expect(result).toStrictEqual({ ranProjectIndices: [0], results: [executeResult] });
		expect(runProjectsAsync).toHaveBeenCalledExactlyOnceWith({
			backend,
			deferFormatting: true,
			parallel: 2,
			projects: jobs,
			scriptFactory,
			scriptOverride: "initial-script",
			startTime: 123,
			timing,
			tsconfigCache,
			version: "1.2.3",
		});
		expect(timing.profileAsync).toHaveBeenCalledOnce();
	});
});

describe(buildWorkspaceJobs, () => {
	it("should pin the shared place and package onto every built job", () => {
		expect.assertions(2);

		const built = fromAny<ProjectJob, unknown>({
			config: { rootDir: "/repo" },
			displayName: "unit",
		});
		vi.mocked(buildProjectJob).mockReturnValue(built);
		const tsconfigCache: TsconfigMappingCache = new Map();
		const projectConfig = { placeFile: "old.rbxl", rootDir: "/repo" };

		const result = buildWorkspaceJobs(
			[
				fromAny<PendingEntry, unknown>({
					pkg: "pkg-a",
					project: { displayColor: "cyan", displayName: "unit" },
					projectConfig,
					testFiles: ["unit.spec.ts"],
				}),
			],
			"workspace.rbxl",
			tsconfigCache,
		);

		expect(buildProjectJob).toHaveBeenCalledExactlyOnceWith(
			{
				config: { ...projectConfig, placeFile: "workspace.rbxl" },
				displayColor: "cyan",
				displayName: "unit",
				pkg: "pkg-a",
				testFiles: ["unit.spec.ts"],
			},
			tsconfigCache,
		);
		expect(result).toStrictEqual([{ ...built, pkg: "pkg-a" }]);
	});
});

describe(prepareWorkspaceDispatchAsync, () => {
	it("should build a retry script from exact package and project matches", async () => {
		expect.assertions(3);

		const unitA = makeJob("pkg-a", "unit");
		const unitB = makeJob("pkg-b", "unit");
		const e2eA = makeJob("pkg-a", "e2e");
		vi.mocked(generateMaterializerScript).mockImplementation((inputs, options) => {
			return JSON.stringify({ inputs, options });
		});

		const spec = await prepareWorkspaceDispatchAsync({
			bail: true,
			jobs: [unitA, unitB, e2eA],
			parallel: 1,
			workStealingCredentials: undefined,
		});
		assert(spec.scriptFactory !== undefined);
		assert(spec.scriptOverride !== undefined);

		const retryScript = spec.scriptFactory([unitA]);

		expect(JSON.parse(spec.scriptOverride)).toStrictEqual({
			inputs: [materializerInput(unitA), materializerInput(unitB), materializerInput(e2eA)],
			options: { bail: true },
		});
		expect(JSON.parse(retryScript)).toStrictEqual({
			inputs: [materializerInput(unitA)],
			options: { bail: true },
		});
		expect(spec).not.toHaveProperty("workStealing");
	});

	it("should return a work-stealing script when queue setup succeeds", async () => {
		expect.assertions(2);

		const job = makeJob("pkg-a", "unit");
		vi.mocked(isShardedParallel).mockReturnValue(true);
		vi.mocked(prepareWorkStealingQueueAsync).mockResolvedValue({
			invisibilityWindowSeconds: 90,
			queueId: "queue-1",
			ttlSeconds: 600,
		});
		vi.mocked(generateWorkStealingScript).mockReturnValue("stealing-script");
		const credentials = { apiKey: "key", baseUrl: "https://example.test", universeId: "42" };

		const spec = await prepareWorkspaceDispatchAsync({
			jobs: [job],
			parallel: "auto",
			workStealingCredentials: credentials,
		});

		expect(prepareWorkStealingQueueAsync).toHaveBeenCalledExactlyOnceWith({
			baseUrl: "https://example.test",
			credentials: { apiKey: "key", universeId: "42" },
			packages: [{ pkg: "pkg-a", project: "unit" }],
			perPackageTimeoutSeconds: 60,
		});
		expect(spec).toStrictEqual({
			parallel: "auto",
			scriptOverride: "stealing-script",
			workStealing: true,
		});
	});

	it("should size the invisibility window off the slowest package's budget", async () => {
		expect.assertions(1);

		vi.mocked(isShardedParallel).mockReturnValue(true);
		vi.mocked(prepareWorkStealingQueueAsync).mockResolvedValue({
			invisibilityWindowSeconds: 210,
			queueId: "queue-1",
			ttlSeconds: 600,
		});
		vi.mocked(generateWorkStealingScript).mockReturnValue("stealing-script");

		await prepareWorkspaceDispatchAsync({
			jobs: [makeJob("pkg-a", "unit"), makeJob("pkg-b", "unit", { projectTimeout: 180_000 })],
			parallel: "auto",
			workStealingCredentials: { apiKey: "key", universeId: "42" },
		});

		expect(prepareWorkStealingQueueAsync).toHaveBeenCalledWith(
			expect.objectContaining({ perPackageTimeoutSeconds: 180 }),
		);
	});

	// A package with no budget of its own is bounded only by the deadline
	// Roblox gives the whole task, so that is the window a sibling must wait
	// out before reclaiming it.
	it("should fall back to the task deadline for a package with no budget", async () => {
		expect.assertions(1);

		vi.mocked(isShardedParallel).mockReturnValue(true);
		vi.mocked(prepareWorkStealingQueueAsync).mockResolvedValue({
			invisibilityWindowSeconds: 330,
			queueId: "queue-1",
			ttlSeconds: 600,
		});
		vi.mocked(generateWorkStealingScript).mockReturnValue("stealing-script");

		await prepareWorkspaceDispatchAsync({
			jobs: [makeJob("pkg-a", "unit", { projectTimeout: 0 })],
			parallel: "auto",
			workStealingCredentials: { apiKey: "key", universeId: "42" },
		});

		expect(prepareWorkStealingQueueAsync).toHaveBeenCalledWith(
			expect.objectContaining({ perPackageTimeoutSeconds: 300 }),
		);
	});

	// Every task runs under the first job's `timeout`, so a later package's own
	// run timeout is not the deadline it will be worked on under. Reading it as
	// one sizes the window under the deadline, and the item is reclaimed and
	// run a second time while the first task is still inside it.
	it("should take an unbudgeted package's deadline from the first job", async () => {
		expect.assertions(1);

		vi.mocked(isShardedParallel).mockReturnValue(true);
		vi.mocked(prepareWorkStealingQueueAsync).mockResolvedValue({
			invisibilityWindowSeconds: 330,
			queueId: "queue-1",
			ttlSeconds: 600,
		});
		vi.mocked(generateWorkStealingScript).mockReturnValue("stealing-script");

		await prepareWorkspaceDispatchAsync({
			jobs: [
				makeJob("pkg-a", "unit"),
				makeJob("pkg-b", "unit", { projectTimeout: 0, timeout: 60_000 }),
			],
			parallel: "auto",
			workStealingCredentials: { apiKey: "key", universeId: "42" },
		});

		expect(prepareWorkStealingQueueAsync).toHaveBeenCalledWith(
			expect.objectContaining({ perPackageTimeoutSeconds: 300 }),
		);
	});

	// A budget past the task deadline cannot be reached: Roblox ends the task
	// first. Waiting it out only delays the reclaim of an item whose worker is
	// already gone.
	it("should cap a package budget at the task deadline", async () => {
		expect.assertions(1);

		vi.mocked(isShardedParallel).mockReturnValue(true);
		vi.mocked(prepareWorkStealingQueueAsync).mockResolvedValue({
			invisibilityWindowSeconds: 330,
			queueId: "queue-1",
			ttlSeconds: 600,
		});
		vi.mocked(generateWorkStealingScript).mockReturnValue("stealing-script");

		await prepareWorkspaceDispatchAsync({
			jobs: [makeJob("pkg-a", "unit", { projectTimeout: 900_000 })],
			parallel: "auto",
			workStealingCredentials: { apiKey: "key", universeId: "42" },
		});

		expect(prepareWorkStealingQueueAsync).toHaveBeenCalledWith(
			expect.objectContaining({ perPackageTimeoutSeconds: 300 }),
		);
	});

	it("should warn and fall back to a sequential script when queue setup fails", async () => {
		expect.assertions(3);

		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		onTestFinished(() => {
			stderr.mockRestore();
		});
		vi.mocked(isShardedParallel).mockReturnValue(true);
		vi.mocked(prepareWorkStealingQueueAsync).mockRejectedValue(new Error("missing scope"));
		vi.mocked(generateMaterializerScript).mockReturnValue("sequential-script");

		const spec = await prepareWorkspaceDispatchAsync({
			jobs: [makeJob("pkg-a", "unit")],
			parallel: 2,
			workStealingCredentials: { apiKey: "key", universeId: "42" },
		});

		expect(stderr).toHaveBeenCalledExactlyOnceWith(
			"Warning: could not set up the work-stealing queue, running packages " +
				"one task at a time: missing scope\n" +
				"Grant the API key memory-store.queue:add/dequeue/discard to run " +
				"them in parallel.\n",
		);
		expect(spec.scriptFactory).toBeTypeOf("function");
		expect(spec.scriptOverride).toBe("sequential-script");
	});
});
