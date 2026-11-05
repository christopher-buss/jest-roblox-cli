import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";

import type { MemoryVolume } from "#test/mocks/memory-file-system.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { NOOP_PROGRESS } from "#test/mocks/noop-progress.ts";
import { PLACE_INPUT_BY_KIND } from "#test/mocks/place-input.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import { makeJestResult } from "#test/mocks/spec-results.ts";
import packageJson from "../../package.json" with { type: "json" };
import type { Backend } from "../backends/interface.ts";
import type { CliOptions, ResolvedConfig } from "../config/schema.ts";
import type { ExecuteResult } from "../executor.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import type { ExecutionInput } from "./execution.ts";
import { resolveRunBackendAsync, runTestPlanAsync, runTypecheckPassAsync } from "./execution.ts";
import type { RunSeams } from "./seams.ts";
import type { PendingJob, TestPlan } from "./test-plan.ts";

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
	resolveBackend: Mock<RunSeams["resolveBackend"]>;
	runProjects: Mock<RunSeams["runProjects"]>;
	runTypecheck: Mock<RunSeams["runTypecheck"]>;
}

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return {
		...createResolvedConfig(),
		rojoProject: "default.project.json",
		rootDir: "/test",
		testMatch: ["**/*.spec.ts"],
		testPathIgnorePatterns: [],
		...overrides,
	};
}

function makeExecuteResult(output: string): ExecuteResult {
	return {
		exitCode: 0,
		output,
		result: makeJestResult(),
		timing: { executionMs: 1, startTime: 1000, testsMs: 1, totalMs: 1, uploadMs: 1 },
	};
}

function makeBackend(kind: Backend["kind"]): Backend {
	return {
		kind,
		placeInput: PLACE_INPUT_BY_KIND[kind],
		runTestsAsync: vi.fn<Backend["runTestsAsync"]>(),
	};
}

function makeJob(displayName: string): PendingJob {
	return {
		config: makeConfig(),
		displayColor: "blue",
		displayName,
		runtimeFiles: [`src/${displayName}/a.spec.ts`],
		runtimeInjectionPaths: [`ReplicatedStorage/${displayName}`],
	};
}

function recordingTiming() {
	const asyncNames: Array<string> = [];
	const records: Array<{ elapsedMs: number; name: string }> = [];
	const describeStage = vi.fn<TimingCollector["progress"]["describe"]>();
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
		progress: { ...NOOP_PROGRESS, describe: describeStage },
		record: (name, elapsedMs) => {
			records.push({ name, elapsedMs });
		},
	};
	return { asyncNames, describeStage, records, timing };
}

function createFakes(volume: MemoryVolume): Fakes {
	const fakes: Fakes = {
		execFile: vi.fn<RojoExec>(),
		resolveBackend: vi.fn<RunSeams["resolveBackend"]>(),
		runProjects: vi.fn<RunSeams["runProjects"]>(),
		runTypecheck: vi.fn<RunSeams["runTypecheck"]>(),
	};
	fakes.execFile.mockImplementation((...[, args, , callback]) => {
		const outputPath = String(args[3]);
		volume.mkdirSync(path.dirname(outputPath), { recursive: true });
		volume.writeFileSync(outputPath, "RBXL");
		callback(null, "", "");
	});
	fakes.runProjects.mockImplementation(async ({ projects }) => {
		return {
			backendTiming: { executionMs: 1, uploadMs: 1 },
			ranProjectIndices: projects.map((_project, index) => index),
			results: projects.map(({ displayName }) => makeExecuteResult(displayName ?? "")),
		};
	});
	fakes.runTypecheck.mockResolvedValue(makeJestResult());
	return fakes;
}

function toSeams(fakes: Fakes): RunSeams {
	return fromAny({
		childProcess: { execFile: fakes.execFile },
		resolveBackend: fakes.resolveBackend,
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

function setup({
	backendKind = "studio",
	config = makeConfig(),
	plan = { jobs: [makeJob("client")], matchedRuntimeFiles: [], typeTestEntries: [] },
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
		codeRoots: undefined,
		discovery: {
			cliFiles: undefined,
			cliTypecheck: {},
			fileSystem,
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

describe(runTypecheckPassAsync, () => {
	it("should run one typecheck per group with the run-wide policy", async () => {
		expect.assertions(2);

		const runTypecheck = vi.fn<RunSeams["runTypecheck"]>().mockResolvedValue(makeJestResult());

		const outcome = await runTypecheckPassAsync({
			cliTypecheck: {},
			entries: [{ cwd: "/test", files: ["a.spec-d.ts"], tsconfig: "tsconfig.json" }],
			rootConfig: makeConfig({
				timeout: 1234,
				typecheck: { ignoreSourceErrors: true, spawnTimeout: 99 },
			}),
			runTypecheck,
		});

		expect(runTypecheck).toHaveBeenCalledExactlyOnceWith({
			files: ["a.spec-d.ts"],
			ignoreSourceErrors: true,
			rootDir: "/test",
			spawnTimeout: 99,
			timeout: 1234,
			tsconfig: "tsconfig.json",
		});
		expect(outcome.result).toBeDefined();
	});
});

describe(resolveRunBackendAsync, () => {
	it("should resolve the backend inside a resolveBackend span", async () => {
		expect.assertions(3);

		const { fakes, input, recorded } = setup();
		const backend = makeBackend("studio");
		fakes.resolveBackend.mockResolvedValue(backend);
		const cli: CliOptions = { backend: "studio" };
		const config = makeConfig();

		const result = await resolveRunBackendAsync({
			cli,
			config,
			seams: input.discovery.seams,
			timing: recorded.timing,
		});

		expect(result).toBe(backend);
		expect(fakes.resolveBackend).toHaveBeenCalledExactlyOnceWith({ cli, config });
		expect(recorded.asyncNames).toStrictEqual(["resolveBackend"]);
	});
});

describe(runTestPlanAsync, () => {
	it("should build the dispatch place for a backend that takes a built place", async () => {
		expect.assertions(5);

		const { fakes, input, recorded, volume } = setup({ backendKind: "open-cloud" });

		const outcome = await runTestPlanAsync(input);

		expect(fakes.execFile).toHaveBeenCalledOnce();
		expect(volume.existsSync(path.resolve(CACHE_ROOT, "synth.project.json"))).toBeTrue();
		expect(recorded.asyncNames).toStrictEqual(["buildOpenCloudPlace", "runProjects"]);
		expect(recorded.describeStage).toHaveBeenCalledWith("build", expect.any(String));
		expect(outcome.placeBuildMs).toBe(7);
	});

	it("should build from the default rojo project when the config names none", async () => {
		expect.assertions(1);

		const { fakes, input } = setup({
			backendKind: "open-cloud",
			config: makeConfig({ rojoProject: undefined }),
		});

		await runTestPlanAsync(input);

		expect(fakes.execFile).toHaveBeenCalledOnce();
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

	it("should dispatch each job and pair results to jobs by ran index", async () => {
		expect.assertions(2);

		const { fakes, input } = setup({
			plan: {
				jobs: [makeJob("client"), makeJob("server")],
				matchedRuntimeFiles: [],
				typeTestEntries: [],
			},
		});
		fakes.runProjects.mockResolvedValueOnce({
			backendTiming: { executionMs: 1, uploadMs: 1 },
			ranProjectIndices: [1],
			results: [makeExecuteResult("server")],
		});

		const outcome = await runTestPlanAsync(input);

		expect(fakes.runProjects.mock.calls[0]![0]).toMatchObject({
			deferFormatting: true,
			parallel: undefined,
			projects: [
				{
					config: input.plan.jobs[0]!.config,
					displayColor: "blue",
					displayName: "client",
					runtimeInjectionPaths: ["ReplicatedStorage/client"],
					testFiles: ["src/client/a.spec.ts"],
				},
				expect.objectContaining({ displayName: "server" }),
			],
			version: packageJson.version,
		});
		expect(outcome.projectResults).toStrictEqual([
			{ displayColor: "blue", displayName: "server", result: makeExecuteResult("server") },
		]);
	});

	it("should pass parallel only to an open cloud backend", async () => {
		expect.assertions(2);

		const config = makeConfig({ experimentalVmParallel: 2, parallel: 3 });
		const openCloud = setup({ backendKind: "open-cloud", config });
		const studio = setup({ backendKind: "studio", config });

		await runTestPlanAsync(openCloud.input);
		await runTestPlanAsync(studio.input);

		expect(openCloud.fakes.runProjects.mock.calls[0]![0]).toMatchObject({
			parallel: 3,
			vmParallel: 2,
		});
		expect(studio.fakes.runProjects.mock.calls[0]![0]).toMatchObject({
			parallel: undefined,
			vmParallel: 2,
		});
	});

	it("should prefer the staged code bundle over none from the place build", async () => {
		expect.assertions(1);

		const { fakes, input } = setup();
		const codeBundle = fromAny<NonNullable<ExecutionInput["staged"]["codeBundle"]>, object>({
			path: "bundle",
		});
		input.staged.codeBundle = codeBundle;

		await runTestPlanAsync(input);

		expect(fakes.runProjects.mock.calls[0]![0].codeBundle).toBe(codeBundle);
	});

	it("should skip the runtime dispatch and record the typecheck span for a types-only plan", async () => {
		expect.assertions(3);

		const { fakes, input, recorded } = setup({
			plan: {
				jobs: [],
				matchedRuntimeFiles: [],
				typeTestEntries: [{ cwd: "/test", files: ["a.spec-d.ts"] }],
			},
		});
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => {
			now += 5;
			return now;
		});

		const outcome = await runTestPlanAsync(input);

		expect(fakes.runProjects).not.toHaveBeenCalled();
		expect(outcome.projectResults).toStrictEqual([]);
		expect(recorded.records).toStrictEqual([{ name: "runTypecheck", elapsedMs: 5 }]);
	});
});
