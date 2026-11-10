import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";

import type { MemoryVolume } from "#test/mocks/memory-file-system.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { NOOP_PROGRESS } from "#test/mocks/noop-progress.ts";
import { fakeBackendOfKind } from "#test/mocks/place-input.ts";
import { projectJob } from "#test/mocks/project-job.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import { writingRojoExec } from "#test/mocks/rojo-exec.ts";
import { makeJestResult } from "#test/mocks/spec-results.ts";
import type { Backend } from "../backends/dispatch-request.ts";
import type { BackendResult, DispatchBase } from "../backends/interface.ts";
import type { ResolvedConfig } from "../config/resolved-config.ts";
import type { ConfiguredJob, ExecuteResult } from "../executor/executor-types.ts";
import type { RunProgress } from "../progress/run-progress.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import { buildPlaceForBackendAsync } from "./execution.ts";
import type { RunDiscovery, TestPlan } from "./run-plan.ts";
import type { RunSeams } from "./seams.ts";
import type { StagedRun } from "./staging.ts";

const CACHE_ROOT = path.resolve("/test", ".jest-roblox", "cache");

type ExecCallback = (cause: Error | null, stdout: string, stderr: string) => void;
type RojoExec = (
	file: string,
	args: Array<string>,
	options: object,
	callback: ExecCallback,
) => void;

interface Fakes {
	execFile: Mock<RojoExec>;
	runProjects: Mock<RunSeams["runProjects"]>;
	runTypecheck: Mock<RunSeams["runTypecheck"]>;
}

interface ExecutionInput {
	backend: Backend;
	cli: object;
	discovery: RunDiscovery;
	plan: TestPlan;
	staged: StagedRun;
}

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return {
		...createResolvedConfig(),
		rojoProject: path.resolve("/test", "default.project.json"),
		rootDir: "/test",
		testMatch: ["**/*.spec.ts"],
		testPathIgnorePatterns: [],
		...overrides,
	};
}

function makeExecuteResult(): ExecuteResult {
	return {
		exitCode: 0,
		result: makeJestResult(),
		timing: { executionMs: 1, startTime: 1000, testsMs: 1, totalMs: 1, uploadMs: 1 },
	};
}

function makeBackend(kind: Backend["kind"]): Backend {
	return fakeBackendOfKind(kind, {
		runTestsAsync: vi.fn<(request: DispatchBase) => Promise<BackendResult>>(),
	});
}

function makeJob(displayName: string): ConfiguredJob {
	return projectJob({
		config: makeConfig(),
		displayColor: "blue",
		displayName,
		runtimeInjectionPaths: [`ReplicatedStorage/${displayName}`],
		testFiles: [`src/${displayName}/a.spec.ts`],
	});
}

function recordingTiming() {
	const asyncNames: Array<string> = [];
	const records: Array<{ elapsedMs: number; name: string }> = [];
	const describeStage = vi.fn<RunProgress["describe"]>();
	const progress: RunProgress = { ...NOOP_PROGRESS, describe: describeStage };
	const timing: TimingCollector = {
		enabled: false,
		flushTimingReport: () => {
			/* unused */
		},
		profile: (_name, func) => func(),
		profileAsync: async (name, func) => {
			asyncNames.push(name);
			return func();
		},
		profileTimed: (_name, func) => ({ elapsedMs: 0, value: func() }),
		profileTimedAsync: async (name, func) => {
			asyncNames.push(name);
			return { elapsedMs: 7, value: await func() };
		},
		record: (name, elapsedMs) => {
			records.push({ name, elapsedMs });
		},
	};
	return { asyncNames, describeStage, progress, records, timing };
}

function createFakes(volume: MemoryVolume): Fakes {
	const fakes: Fakes = {
		execFile: vi.fn<RojoExec>(),
		runProjects: vi.fn<RunSeams["runProjects"]>(),
		runTypecheck: vi.fn<RunSeams["runTypecheck"]>(),
	};
	fakes.execFile.mockImplementation(writingRojoExec({ bytes: "RBXL", fileSystem: volume }));
	fakes.runProjects.mockImplementation(async ({ jobs }) => {
		return {
			backendTiming: { executionMs: 1, uploadMs: 1 },
			results: jobs.map((_job, jobIndex) => ({ ...makeExecuteResult(), jobIndex })),
		};
	});
	fakes.runTypecheck.mockResolvedValue(makeJestResult());
	return fakes;
}

function toSeams(fakes: Fakes): RunSeams {
	return fromAny({
		childProcess: { execFile: fakes.execFile },
		runProjects: fakes.runProjects,
		runTypecheck: fakes.runTypecheck,
	});
}

function writeRojoProject(volume: MemoryVolume): void {
	volume.mkdirSync("/test/out/client", { recursive: true });
	volume.writeFileSync(
		"/test/default.project.json",
		JSON.stringify({
			name: "test",
			tree: {
				$className: "DataModel",
				ReplicatedStorage: { client: { $path: "out/client" } },
			},
		}),
	);
}

async function runTestPlanAsync({ backend, discovery, staged }: ExecutionInput) {
	const placeBuild = await buildPlaceForBackendAsync({ backend, discovery, staged });
	return { placeBuildMs: placeBuild.elapsedMs };
}

function setup({
	backendKind = "studio",
	config = makeConfig(),
	plan = {
		jobs: [makeJob("client")],
		matchedRuntimeFiles: [],
		projects: [],
		tsconfigCache: new Map(),
		typeTestEntries: [],
	},
}: {
	backendKind?: Backend["kind"];
	config?: ResolvedConfig;
	plan?: TestPlan;
} = {}) {
	const { fileSystem, volume } = createMemoryFileSystem();
	writeRojoProject(volume);
	const fakes = createFakes(volume);
	const recorded = recordingTiming();
	const input: ExecutionInput = {
		backend: makeBackend(backendKind),
		cli: {},
		discovery: {
			cliFiles: undefined,
			cliTypecheck: {},
			fileSystem,
			partialRun: undefined,
			progress: recorded.progress,
			projects: [],
			rootConfig: config,
			seams: toSeams(fakes),
			timing: recorded.timing,
		},
		plan,
		staged: { cacheRoot: CACHE_ROOT, coverageMs: 0, effectiveConfig: config, stagingMs: 0 },
	};
	return { fakes, input, recorded, volume };
}

describe(buildPlaceForBackendAsync, () => {
	it("should build the dispatch place for a backend that takes a built place", async () => {
		expect.assertions(5);

		const { fakes, input, recorded, volume } = setup({ backendKind: "open-cloud" });

		const outcome = await runTestPlanAsync(input);

		expect(fakes.execFile).toHaveBeenCalledOnce();
		expect(volume.existsSync(path.resolve(CACHE_ROOT, "synthesized.project.json"))).toBeTrue();
		expect(recorded.asyncNames).toStrictEqual(["rojoBuild"]);
		expect(recorded.describeStage).toHaveBeenCalledWith("build", expect.any(String));
		expect(outcome.placeBuildMs).toBe(7);
	});

	it("should build a loadstring-enabled place for studio-cli to open", async () => {
		expect.assertions(2);

		const { fakes, input, volume } = setup({ backendKind: "studio-cli" });

		await runTestPlanAsync(input);

		expect(fakes.execFile).toHaveBeenCalledOnce();
		expect(
			String(
				volume.readFileSync(path.resolve(CACHE_ROOT, "synthesized.project.json"), "utf8"),
			),
		).toContain('"LoadStringEnabled": true');
	});

	it("should refuse to build when the config has no Rojo project", async () => {
		expect.assertions(1);

		const { input } = setup({
			backendKind: "open-cloud",
			config: makeConfig({ rojoProject: undefined }),
		});

		await expect(runTestPlanAsync(input)).rejects.toThrow("No Rojo project found");
	});

	it("should build no place for a backend that takes none", async () => {
		expect.assertions(2);

		const { fakes, input } = setup({ backendKind: "studio" });

		const outcome = await runTestPlanAsync(input);

		expect(fakes.execFile).not.toHaveBeenCalled();
		expect(outcome.placeBuildMs).toBe(0);
	});

	it("should build no place on a coverage run", async () => {
		expect.assertions(1);

		const { fakes, input } = setup({
			backendKind: "open-cloud",
			config: makeConfig({ collectCoverage: true }),
		});

		await runTestPlanAsync(input);

		expect(fakes.execFile).not.toHaveBeenCalled();
	});
});
