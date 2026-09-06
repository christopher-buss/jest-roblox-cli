import { fromAny } from "@total-typescript/shoehorn";

import process from "node:process";
import { assert, describe, expect, it, onTestFinished, vi } from "vitest";

import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import type { Backend, ProjectJob } from "../backends/interface.ts";
import { DEFAULT_CONFIG } from "../config/schema.ts";
import type { ExecuteResult, runProjectsAsync, RunProjectsResult } from "../executor.ts";
import type { TsconfigMappingCache } from "../executor/tsconfig-mappings.ts";
import type { prepareWorkStealingQueueAsync } from "../memory-store/work-stealing.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import {
	buildWorkspaceJobs,
	prepareWorkspaceDispatchAsync,
	runDispatchedProjectsAsync,
	type WorkspaceJob,
} from "./dispatch.ts";
import type { PendingEntry } from "./test-selection.ts";

interface DispatchedPayload {
	bail?: boolean;
	entries: Array<{ pkg: string; project: string }>;
	invisibilityWindowSeconds?: number;
	queueId?: string;
	queueTtlSeconds?: number;
}

function payloadOf(script: string): DispatchedPayload {
	const embedded = /\[==\[([\S\s]*?)]==]/.exec(script);
	assert(embedded !== null);
	return fromAny<DispatchedPayload, JSONValue>(JSON.parse(embedded[1]!));
}

function dispatchedPairs(script: string): Array<string> {
	return payloadOf(script).entries.map((entry) => `${entry.pkg}/${entry.project}`);
}

function makeJob(
	packageName: string,
	displayName: string,
	config: { projectTimeout?: number; timeout?: number } = {},
): WorkspaceJob {
	return fromAny({
		config: {
			...DEFAULT_CONFIG,
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

function createTiming(): TimingCollector {
	return fromAny({
		profileAsync: vi.fn<(name: string, action: () => Promise<unknown>) => Promise<unknown>>(
			async (_name, action) => action(),
		),
	});
}

function stubQueue(): ReturnType<typeof vi.fn<typeof prepareWorkStealingQueueAsync>> {
	return vi.fn<typeof prepareWorkStealingQueueAsync>(async (options) => {
		return {
			invisibilityWindowSeconds: options.perPackageTimeoutSeconds + 30,
			queueId: "queue-1",
			ttlSeconds: 600,
		};
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
		const runProjects = vi.fn<typeof runProjectsAsync>(async () => {
			return fromAny<RunProjectsResult, unknown>({
				backendTiming: {},
				ranProjectIndices: [0],
				results: [executeResult],
			});
		});
		const scriptFactory = vi.fn<(jobs: ReadonlyArray<ProjectJob>) => string>(
			() => "retry-script",
		);

		const result = await runDispatchedProjectsAsync({
			backend,
			dispatchSpec: { parallel: 2, scriptFactory, scriptOverride: "initial-script" },
			jobs,
			runProjects,
			startTime: 123,
			timing,
			tsconfigCache,
			version: "1.2.3",
		});

		expect(result).toStrictEqual({ ranProjectIndices: [0], results: [executeResult] });
		expect(runProjects).toHaveBeenCalledExactlyOnceWith({
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
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();
		const projectConfig = {
			...DEFAULT_CONFIG,
			placeFile: "old.rbxl",
			rootDir: "/repo",
			snapshotFormat: { printBasicPrototype: true },
		};

		const result = buildWorkspaceJobs({
			fileSystem,
			pending: [
				fromAny<PendingEntry, unknown>({
					pkg: "pkg-a",
					project: { displayColor: "cyan", displayName: "unit" },
					projectConfig,
					testFiles: ["unit.spec.ts"],
				}),
			],
			placeFile: "workspace.rbxl",
			tsconfigCache: new Map(),
			tsconfigReader: () => null,
		});

		expect(result).toStrictEqual([
			{
				config: { ...projectConfig, placeFile: "workspace.rbxl" },
				displayColor: "cyan",
				displayName: "unit",
				pkg: "pkg-a",
				runtimeInjectionPaths: undefined,
				testFiles: ["unit.spec.ts"],
			},
		]);
	});
});

describe(prepareWorkspaceDispatchAsync, () => {
	it("should build a script from exact package and project matches", async () => {
		expect.assertions(4);

		const unitA = makeJob("pkg-a", "unit");
		const unitB = makeJob("pkg-b", "unit");
		const e2eA = makeJob("pkg-a", "e2e");

		const spec = await prepareWorkspaceDispatchAsync({
			bail: true,
			jobs: [unitA, unitB, e2eA],
			parallel: 1,
			workStealingCredentials: undefined,
		});
		assert(spec.scriptFactory !== undefined);

		const whole = payloadOf(spec.scriptFactory([unitA, unitB, e2eA]));

		expect(whole.entries.map((entry) => `${entry.pkg}/${entry.project}`)).toStrictEqual([
			"pkg-a/unit",
			"pkg-b/unit",
			"pkg-a/e2e",
		]);
		expect(whole.bail).toBeTrue();
		expect(dispatchedPairs(spec.scriptFactory([unitA]))).toStrictEqual(["pkg-a/unit"]);
		expect(spec).not.toHaveProperty("workStealing");
	});

	it("should return a work-stealing script when queue setup succeeds", async () => {
		expect.assertions(2);

		const job = makeJob("pkg-a", "unit");
		const prepareWorkStealingQueue = stubQueue();
		const credentials = { apiKey: "key", baseUrl: "https://example.test", universeId: "42" };

		const spec = await prepareWorkspaceDispatchAsync({
			jobs: [job],
			parallel: "auto",
			prepareWorkStealingQueue,
			workStealingCredentials: credentials,
		});

		expect(prepareWorkStealingQueue).toHaveBeenCalledExactlyOnceWith({
			baseUrl: "https://example.test",
			credentials: { apiKey: "key", universeId: "42" },
			packages: [{ pkg: "pkg-a", project: "unit" }],
			perPackageTimeoutSeconds: 60,
		});

		assert(spec.scriptOverride !== undefined);

		expect({ ...spec, scriptOverride: payloadOf(spec.scriptOverride) }).toStrictEqual({
			parallel: "auto",
			scriptOverride: expect.objectContaining({
				invisibilityWindowSeconds: 90,
				queueId: "queue-1",
				queueTtlSeconds: 600,
			}),
			workStealing: true,
		});
	});

	it("should size the invisibility window off the slowest package's budget", async () => {
		expect.assertions(1);

		const prepareWorkStealingQueue = stubQueue();

		await prepareWorkspaceDispatchAsync({
			jobs: [makeJob("pkg-a", "unit"), makeJob("pkg-b", "unit", { projectTimeout: 180_000 })],
			parallel: "auto",
			prepareWorkStealingQueue,
			workStealingCredentials: { apiKey: "key", universeId: "42" },
		});

		expect(prepareWorkStealingQueue).toHaveBeenCalledWith(
			expect.objectContaining({ perPackageTimeoutSeconds: 180 }),
		);
	});

	// A package with no budget of its own is bounded only by the deadline
	// Roblox gives the whole task, so that is the window a sibling must wait
	// out before reclaiming it.
	it("should fall back to the task deadline for a package with no budget", async () => {
		expect.assertions(1);

		const prepareWorkStealingQueue = stubQueue();

		await prepareWorkspaceDispatchAsync({
			jobs: [makeJob("pkg-a", "unit", { projectTimeout: 0 })],
			parallel: "auto",
			prepareWorkStealingQueue,
			workStealingCredentials: { apiKey: "key", universeId: "42" },
		});

		expect(prepareWorkStealingQueue).toHaveBeenCalledWith(
			expect.objectContaining({ perPackageTimeoutSeconds: 300 }),
		);
	});

	// Every task runs under the first job's `timeout`, so a later package's own
	// run timeout is not the deadline it will be worked on under. Reading it as
	// one sizes the window under the deadline, and the item is reclaimed and
	// run a second time while the first task is still inside it.
	it("should take an unbudgeted package's deadline from the first job", async () => {
		expect.assertions(1);

		const prepareWorkStealingQueue = stubQueue();

		await prepareWorkspaceDispatchAsync({
			jobs: [
				makeJob("pkg-a", "unit"),
				makeJob("pkg-b", "unit", { projectTimeout: 0, timeout: 60_000 }),
			],
			parallel: "auto",
			prepareWorkStealingQueue,
			workStealingCredentials: { apiKey: "key", universeId: "42" },
		});

		expect(prepareWorkStealingQueue).toHaveBeenCalledWith(
			expect.objectContaining({ perPackageTimeoutSeconds: 300 }),
		);
	});

	// A budget past the task deadline cannot be reached: Roblox ends the task
	// first. Waiting it out only delays the reclaim of an item whose worker is
	// already gone.
	it("should cap a package budget at the task deadline", async () => {
		expect.assertions(1);

		const prepareWorkStealingQueue = stubQueue();

		await prepareWorkspaceDispatchAsync({
			jobs: [makeJob("pkg-a", "unit", { projectTimeout: 900_000 })],
			parallel: "auto",
			prepareWorkStealingQueue,
			workStealingCredentials: { apiKey: "key", universeId: "42" },
		});

		expect(prepareWorkStealingQueue).toHaveBeenCalledWith(
			expect.objectContaining({ perPackageTimeoutSeconds: 300 }),
		);
	});

	it("should hand the stealing script the queue TTL the queue was seeded with", async () => {
		expect.assertions(1);

		const spec = await prepareWorkspaceDispatchAsync({
			jobs: [makeJob("pkg-a", "unit")],
			parallel: "auto",
			prepareWorkStealingQueue: stubQueue(),
			workStealingCredentials: { apiKey: "key", universeId: "42" },
		});
		assert(spec.scriptOverride !== undefined);

		expect(payloadOf(spec.scriptOverride)).toStrictEqual({
			entries: [expect.objectContaining({ pkg: "pkg-a", project: "unit" })],
			invisibilityWindowSeconds: 90,
			queueId: "queue-1",
			queueTtlSeconds: 600,
		});
	});

	it("should warn and fall back to a sequential script when queue setup fails", async () => {
		expect.assertions(3);

		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		onTestFinished(() => {
			stderr.mockRestore();
		});
		const spec = await prepareWorkspaceDispatchAsync({
			jobs: [makeJob("pkg-a", "unit")],
			parallel: 2,
			prepareWorkStealingQueue: vi.fn<typeof prepareWorkStealingQueueAsync>(async () => {
				throw new Error("missing scope");
			}),
			workStealingCredentials: { apiKey: "key", universeId: "42" },
		});

		expect(stderr).toHaveBeenCalledExactlyOnceWith(
			"Warning: could not set up the work-stealing queue, running packages " +
				"with no work-stealing: missing scope\n" +
				"Grant the API key memory-store.queue:add/dequeue/discard so tasks " +
				"can rebalance instead of running a fixed share each.\n",
		);
		expect(spec.scriptFactory).toBeTypeOf("function");
		// The fallback loses work-stealing, not concurrency: the backend
		// buckets the entries statically, which needs the count to survive.
		expect(spec.parallel).toBe(2);
	});
});
