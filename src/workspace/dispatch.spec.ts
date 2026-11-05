import { fromAny } from "@total-typescript/shoehorn";

import process from "node:process";
import { assert, describe, expect, it, onTestFinished, vi } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { Backend, ProjectJob } from "../backends/interface.ts";
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
import type { PendingEntry } from "./pending-entry.ts";

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

function makeJob({
	config = {},
	displayName,
	packageName,
}: {
	readonly config?: { projectTimeout?: number; timeout?: number };
	readonly displayName: string;
	readonly packageName: string;
}): WorkspaceJob {
	return fromAny({
		config: {
			...createResolvedConfig(),
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

		const jobs = [makeJob({ displayName: "unit", packageName: "pkg-a" })];
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
			codeBundle: undefined,
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
		expect(timing.profileAsync).toHaveBeenCalledExactlyOnceWith(
			"runProjects",
			expect.any(Function),
		);
	});
});

describe(buildWorkspaceJobs, () => {
	it("should pin the shared place and package onto every built job", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();
		const projectConfig = {
			...createResolvedConfig(),
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

		const unitA = makeJob({ displayName: "unit", packageName: "pkg-a" });
		const unitB = makeJob({ displayName: "unit", packageName: "pkg-b" });
		const e2eA = makeJob({ displayName: "e2e", packageName: "pkg-a" });

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

	it("should hand --bail to a backend that builds its own payload", async () => {
		expect.assertions(1);

		const spec = await prepareWorkspaceDispatchAsync({
			bail: true,
			jobs: [makeJob({ displayName: "unit", packageName: "pkg-a" })],
			parallel: 1,
			workStealingCredentials: undefined,
		});

		expect(spec.bail).toBeTrue();
	});

	it("should not bail unless asked", async () => {
		expect.assertions(1);

		const spec = await prepareWorkspaceDispatchAsync({
			jobs: [makeJob({ displayName: "unit", packageName: "pkg-a" })],
			parallel: 1,
			workStealingCredentials: undefined,
		});

		expect(spec.bail).toBeFalse();
	});

	it("should hand the VM count to a backend that builds its own payload", async () => {
		expect.assertions(1);

		const spec = await prepareWorkspaceDispatchAsync({
			jobs: [makeJob({ displayName: "unit", packageName: "pkg-a" })],
			parallel: 1,
			vmParallel: "auto",
			workStealingCredentials: undefined,
		});

		expect(spec.vmParallel).toBe("auto");
	});

	it("should fall back to a bucketed script when queue setup fails", async () => {
		expect.assertions(2);

		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		onTestFinished(() => {
			stderr.mockRestore();
		});
		const spec = await prepareWorkspaceDispatchAsync({
			jobs: [makeJob({ displayName: "unit", packageName: "pkg-a" })],
			parallel: 2,
			prepareWorkStealingQueue: vi.fn<typeof prepareWorkStealingQueueAsync>(async () => {
				throw new Error("missing scope");
			}),
			workStealingCredentials: { apiKey: "key", universeId: "42" },
		});

		expect(spec.scriptFactory).toBeTypeOf("function");
		// The fallback loses work-stealing, not concurrency: the backend
		// buckets the entries statically, which needs the count to survive.
		expect(spec.parallel).toBe(2);
	});

	it("should dispatch a work-stealing spec when queue setup succeeds", async () => {
		expect.assertions(1);

		const spec = await prepareWorkspaceDispatchAsync({
			jobs: [makeJob({ displayName: "unit", packageName: "pkg-a" })],
			parallel: "auto",
			prepareWorkStealingQueue: stubQueue(),
			workStealingCredentials: { apiKey: "key", universeId: "42" },
		});

		expect(spec.workStealing).toBeTrue();
	});
});
