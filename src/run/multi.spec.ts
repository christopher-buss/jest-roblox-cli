import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { resolveBackend } from "../backends/auto.ts";
import type { Backend, BackendResult, ProjectJob } from "../backends/interface.ts";
import { narrowConfigByFiles } from "../config/narrow-by-files.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import { resolveAllProjects } from "../config/projects.ts";
import {
	type CliOptions,
	DEFAULT_CONFIG,
	type InlineProjectConfig,
	type ResolvedConfig,
} from "../config/schema.ts";
import { createSetupResolver } from "../config/setup-resolver.ts";
import { generateProjectStubs, syncStubsToShadowDirectory } from "../config/stubs.ts";
import { prepareCoverage } from "../coverage/prepare.ts";
import {
	buildProjectJob,
	executeBackend,
	type ExecuteResult,
	processProjectResult,
} from "../executor.ts";
import { runTypecheck } from "../typecheck/runner.ts";
import type { JestResult } from "../types/jest-result.ts";
import { buildWithRojo } from "../utils/rojo-builder.ts";
import { runMultiProject } from "./multi.ts";

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});

vi.mock(import("../backends/auto"));
vi.mock(import("../config/projects"));
vi.mock(import("../config/setup-resolver"));
vi.mock(import("../config/stubs"));
vi.mock(import("../config/narrow-by-files"));
vi.mock(import("../utils/rojo-builder"));
vi.mock(import("../executor"));
vi.mock(import("../coverage/prepare"));
vi.mock(import("../typecheck/runner"));

const mocks = {
	buildProjectJob: vi.mocked(buildProjectJob),
	buildWithRojo: vi.mocked(buildWithRojo),
	createSetupResolver: vi.mocked(createSetupResolver),
	executeBackend: vi.mocked(executeBackend),
	generateProjectStubs: vi.mocked(generateProjectStubs),
	narrowConfigByFiles: vi.mocked(narrowConfigByFiles),
	prepareCoverage: vi.mocked(prepareCoverage),
	processProjectResult: vi.mocked(processProjectResult),
	resolveAllProjects: vi.mocked(resolveAllProjects),
	resolveBackend: vi.mocked(resolveBackend),
	runTypecheck: vi.mocked(runTypecheck),
	syncStubsToShadowDirectory: vi.mocked(syncStubsToShadowDirectory),
};

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return {
		...DEFAULT_CONFIG,
		rojoProject: "default.project.json",
		rootDir: "/test",
		testMatch: ["**/*.spec.ts"],
		testPathIgnorePatterns: [],
		...overrides,
	};
}

function makeCli(overrides: Partial<CliOptions> = {}): CliOptions {
	return { ...overrides };
}

function makeJestResult(overrides: Partial<JestResult> = {}): JestResult {
	return {
		numFailedTests: 0,
		numPassedTests: 1,
		numPendingTests: 0,
		numTotalTests: 1,
		startTime: 1000,
		success: true,
		testResults: [],
		...overrides,
	};
}

function makeExecuteResult(overrides: Partial<ExecuteResult> = {}): ExecuteResult {
	return {
		exitCode: 0,
		output: "",
		result: makeJestResult(),
		timing: {
			executionMs: 100,
			startTime: 1000,
			testsMs: 50,
			totalMs: 200,
			uploadCached: false,
			uploadMs: 50,
		},
		...overrides,
	};
}

function makeBackendResult(jobs: Array<ProjectJob>): BackendResult {
	return {
		results: jobs.map((job) => {
			return {
				displayColor: job.displayColor,
				displayName: job.displayName,
				elapsedMs: 50,
				result: makeJestResult(),
			};
		}),
		timing: { executionMs: 100, uploadCached: false, uploadMs: 50 },
	};
}

function makeBackend(kind: "open-cloud" | "studio" = "studio"): Backend {
	return {
		close: vi.fn<NonNullable<Backend["close"]>>(),
		kind,
		runTests: vi.fn<Backend["runTests"]>(),
	};
}

function makeResolvedProject(
	overrides: Partial<ResolvedProjectConfig> = {},
): ResolvedProjectConfig {
	return {
		config: makeConfig(),
		displayName: "client",
		include: ["src/client/**/*.spec.ts"],
		outDir: "out/client",
		projects: ["ReplicatedStorage/client"],
		rojoMounts: [{ dataModelPath: "ReplicatedStorage/client", fsPath: "out/client" }],
		testMatch: ["**/*.spec"],
		...overrides,
	};
}

function makeProjectEntry(name: string): InlineProjectConfig {
	return {
		test: {
			displayName: name,
			include: [`src/${name}/**/*.spec.ts`],
			outDir: `out/${name}`,
		},
	};
}

function writeRojoProject(): void {
	const tree = { $className: "DataModel" };
	vol.mkdirSync("/test", { recursive: true });
	vol.writeFileSync("/test/default.project.json", JSON.stringify({ name: "test", tree }));
}

function setupDefaults(configOverrides: Partial<ResolvedConfig> = {}) {
	const config = makeConfig(configOverrides);

	mocks.resolveAllProjects.mockResolvedValue([
		makeResolvedProject({ displayName: "client", outDir: "out/client" }),
		makeResolvedProject({
			displayName: "server",
			include: ["src/server/**/*.spec.ts"],
			outDir: "out/server",
			rojoMounts: [{ dataModelPath: "ServerScriptService/server", fsPath: "out/server" }],
		}),
	]);
	mocks.createSetupResolver.mockReturnValue((input) => input);
	mocks.generateProjectStubs.mockReturnValue(undefined);
	mocks.resolveBackend.mockResolvedValue(makeBackend("studio"));
	mocks.buildProjectJob.mockImplementation((parameters) => {
		return {
			config: parameters.config,
			displayColor: parameters.displayColor,
			displayName: parameters.displayName ?? "",
			testFiles: parameters.testFiles,
		};
	});
	mocks.executeBackend.mockImplementation(async (_backend, jobs) => makeBackendResult(jobs));
	mocks.processProjectResult.mockImplementation((entry, options) => {
		return makeExecuteResult({ result: entry.result, timing: options.backendTiming as never });
	});
	mocks.narrowConfigByFiles.mockImplementation((cfg) => cfg);
	writeRojoProject();
	onTestFinished(() => {
		vol.reset();
	});

	return { config };
}

function seedProjectFiles(): void {
	vol.mkdirSync("/test/src/client", { recursive: true });
	vol.writeFileSync("/test/src/client/a.spec.ts", "");
	vol.mkdirSync("/test/src/server", { recursive: true });
	vol.writeFileSync("/test/src/server/b.spec.ts", "");
}

describe(runMultiProject, () => {
	it("should run all projects when no --project filter is given", async () => {
		expect.assertions(2);

		const { config } = setupDefaults();
		seedProjectFiles();

		const result = await runMultiProject({
			cli: makeCli(),
			config,
			rawProjects: [makeProjectEntry("client"), makeProjectEntry("server")],
		});

		expect(result.mode).toBe("multi");
		expect(result.projectResults).toHaveLength(2);
	});

	it("should filter projects by --project name", async () => {
		expect.assertions(2);

		const { config } = setupDefaults();
		seedProjectFiles();

		const result = await runMultiProject({
			cli: makeCli({ project: ["client"] }),
			config,
			rawProjects: [makeProjectEntry("client"), makeProjectEntry("server")],
		});

		expect(result.projectResults).toHaveLength(1);
		expect(result.projectResults[0]?.displayName).toBe("client");
	});

	it("should throw on unknown --project displayName", async () => {
		expect.assertions(1);

		const { config } = setupDefaults();
		seedProjectFiles();

		await expect(
			runMultiProject({
				cli: makeCli({ project: ["nonexistent"] }),
				config,
				rawProjects: [makeProjectEntry("client")],
			}),
		).rejects.toThrow(/Unknown project name/);
	});

	it("should throw when Rojo project schema is invalid", async () => {
		expect.assertions(1);

		const { config } = setupDefaults();
		// Overwrite with an invalid Rojo project (missing required name)
		vol.writeFileSync("/test/default.project.json", JSON.stringify({ tree: "not-an-object" }));

		await expect(
			runMultiProject({
				cli: makeCli(),
				config,
				rawProjects: [makeProjectEntry("client")],
			}),
		).rejects.toThrow(/Invalid Rojo project/);
	});

	it("should default rojoProject to default.project.json when not configured", async () => {
		expect.assertions(1);

		const { config } = setupDefaults({ rojoProject: undefined });
		seedProjectFiles();

		const result = await runMultiProject({
			cli: makeCli(),
			config,
			rawProjects: [makeProjectEntry("client")],
		});

		expect(result.mode).toBe("multi");
	});

	it("should call buildWithRojo when coverage is disabled", async () => {
		expect.assertions(1);

		const { config } = setupDefaults();
		seedProjectFiles();

		await runMultiProject({
			cli: makeCli(),
			config,
			rawProjects: [makeProjectEntry("client")],
		});

		expect(mocks.buildWithRojo).toHaveBeenCalledOnce();
	});

	it("should skip buildWithRojo and prepare coverage when collectCoverage is true", async () => {
		expect.assertions(3);

		const { config } = setupDefaults({ collectCoverage: true });
		mocks.prepareCoverage.mockReturnValue({
			manifest: {
				files: {},
				generatedAt: new Date().toISOString(),
				instrumenterVersion: 1,
				luauRoots: [],
				nonInstrumentedFiles: {},
				placeFilePath: "/coverage/game.rbxl",
				shadowDir: ".jest-roblox/coverage",
				version: 1,
			},
			placeFile: "/coverage/game.rbxl",
		});
		seedProjectFiles();

		const result = await runMultiProject({
			cli: makeCli(),
			config,
			rawProjects: [makeProjectEntry("client")],
		});

		expect(mocks.buildWithRojo).not.toHaveBeenCalled();
		expect(mocks.prepareCoverage).toHaveBeenCalledOnce();
		expect(result.preCoverageMs).toBeGreaterThanOrEqual(0);
	});

	it("should sync stubs to shadow directory via beforeBuild callback", async () => {
		expect.assertions(1);

		const { config } = setupDefaults({ collectCoverage: true });
		mocks.syncStubsToShadowDirectory.mockReturnValue(false);
		mocks.prepareCoverage.mockImplementation((_config, beforeBuild) => {
			beforeBuild?.(".jest-roblox/coverage");
			return {
				manifest: {
					files: {},
					generatedAt: new Date().toISOString(),
					instrumenterVersion: 1,
					luauRoots: [],
					nonInstrumentedFiles: {},
					placeFilePath: "/coverage/game.rbxl",
					shadowDir: ".jest-roblox/coverage",
					version: 1,
				},
				placeFile: "/coverage/game.rbxl",
			};
		});
		seedProjectFiles();

		await runMultiProject({
			cli: makeCli(),
			config,
			rawProjects: [makeProjectEntry("client")],
		});

		expect(mocks.syncStubsToShadowDirectory).toHaveBeenCalledWith(
			expect.any(Array),
			"/test",
			".jest-roblox/coverage",
		);
	});

	it("should return validationExitCode 2 with message when no test files found", async () => {
		expect.assertions(3);

		const { config } = setupDefaults();
		// Don't seed any test files

		const result = await runMultiProject({
			cli: makeCli(),
			config,
			rawProjects: [makeProjectEntry("client")],
		});

		expect(result.validationExitCode).toBe(2);
		expect(result.validationMessage).toBe("No test files found in any project\n");
		expect(result.projectResults).toHaveLength(0);
	});

	it("should return empty projectResults without validation error when passWithNoTests", async () => {
		expect.assertions(2);

		const { config } = setupDefaults({ passWithNoTests: true });
		// Don't seed any test files

		const result = await runMultiProject({
			cli: makeCli(),
			config,
			rawProjects: [makeProjectEntry("client")],
		});

		expect(result.validationExitCode).toBeUndefined();
		expect(result.projectResults).toHaveLength(0);
	});

	it("should run typecheck across all projects with deduplicated files", async () => {
		expect.assertions(2);

		const { config } = setupDefaults({ typecheck: true });
		mocks.runTypecheck.mockReturnValue(makeJestResult());
		vol.mkdirSync("/test/src/client", { recursive: true });
		vol.writeFileSync("/test/src/client/a.spec.ts", "");
		vol.writeFileSync("/test/src/client/a.spec-d.ts", "");
		vol.mkdirSync("/test/src/server", { recursive: true });
		vol.writeFileSync("/test/src/server/b.spec.ts", "");

		// Both projects produce the same type-test file via deduplication.
		mocks.resolveAllProjects.mockResolvedValue([
			makeResolvedProject({
				displayName: "client",
				include: ["src/client/**/*.spec.ts", "src/client/**/*.spec-d.ts"],
			}),
			makeResolvedProject({
				displayName: "server",
				include: ["src/server/**/*.spec.ts"],
			}),
		]);

		const result = await runMultiProject({
			cli: makeCli(),
			config,
			rawProjects: [makeProjectEntry("client"), makeProjectEntry("server")],
		});

		expect(mocks.runTypecheck).toHaveBeenCalledWith(
			expect.objectContaining({
				files: expect.arrayContaining([expect.stringMatching(/a\.spec-d\.ts$/)]) as unknown,
			}),
		);
		expect(result.typecheckResult).toBeDefined();
	});

	it("should run typecheck-only without runtime jobs", async () => {
		expect.assertions(2);

		const { config } = setupDefaults({ typecheck: true, typecheckOnly: true });
		mocks.runTypecheck.mockReturnValue(makeJestResult());
		vol.mkdirSync("/test/src/client", { recursive: true });
		vol.writeFileSync("/test/src/client/a.spec-d.ts", "");
		mocks.resolveAllProjects.mockResolvedValue([
			makeResolvedProject({
				displayName: "client",
				include: ["src/client/**/*.spec-d.ts"],
			}),
		]);

		const result = await runMultiProject({
			cli: makeCli(),
			config,
			rawProjects: [makeProjectEntry("client")],
		});

		expect(mocks.executeBackend).not.toHaveBeenCalled();
		expect(result.typecheckResult).toBeDefined();
	});

	it("should merge coverage data and source mappers across project results", async () => {
		expect.assertions(2);

		const { config } = setupDefaults();
		seedProjectFiles();

		mocks.processProjectResult.mockImplementation((entry, options) => {
			const tag = entry.displayName;
			return makeExecuteResult({
				coverageData: { [`${tag}.luau`]: { s: { "0": 1 } } },
				result: entry.result,
				sourceMapper: {
					mapFailureMessage: (message) => `[${tag}] ${message}`,
					mapFailureWithLocations: (message) => ({ locations: [], message }),
					resolveTestFilePath: () => {},
				},
				timing: options.backendTiming as never,
			});
		});

		const result = await runMultiProject({
			cli: makeCli(),
			config,
			rawProjects: [makeProjectEntry("client"), makeProjectEntry("server")],
		});

		expect(result.merged.coverageData).toBeDefined();
		expect(result.merged.sourceMapper?.mapFailureMessage("hi")).toContain("hi");
	});

	it("should pass parallel for open-cloud backend and drop it for studio", async () => {
		expect.assertions(2);

		const { config } = setupDefaults({ parallel: 2 });
		mocks.resolveBackend.mockResolvedValueOnce(makeBackend("open-cloud"));
		seedProjectFiles();

		await runMultiProject({
			cli: makeCli(),
			config,
			rawProjects: [makeProjectEntry("client")],
		});

		const openCloudCall = mocks.executeBackend.mock.calls[0];

		expect(openCloudCall?.[2]).toBe(2);

		mocks.executeBackend.mockClear();
		mocks.resolveBackend.mockResolvedValueOnce(makeBackend("studio"));
		await runMultiProject({
			cli: makeCli(),
			config,
			rawProjects: [makeProjectEntry("client")],
		});

		const studioCall = mocks.executeBackend.mock.calls[0];

		expect(studioCall?.[2]).toBeUndefined();
	});

	it("should derive coverage paths via collectCoverageFrom passthrough when computing merged data", async () => {
		expect.assertions(1);

		const { config } = setupDefaults();
		seedProjectFiles();

		// Without coverageData on any project, merged.coverageData stays
		// undefined.
		const result = await runMultiProject({
			cli: makeCli(),
			config,
			rawProjects: [makeProjectEntry("client")],
		});

		expect(result.merged.coverageData).toBeUndefined();
	});

	it("should close the backend even when no jobs were produced", async () => {
		expect.assertions(2);

		const { config } = setupDefaults();
		const backend = makeBackend("studio");
		mocks.resolveBackend.mockResolvedValueOnce(backend);
		// No project files seeded — pendingJobs is empty

		const result = await runMultiProject({
			cli: makeCli({ passWithNoTests: true }),
			config: { ...config, passWithNoTests: true },
			rawProjects: [makeProjectEntry("client")],
		});

		expect(backend.close).toHaveBeenCalledOnce();
		expect(result.projectResults).toHaveLength(0);
	});

	it("should narrow project config by CLI files for Luau-side execution", async () => {
		expect.assertions(1);

		const { config } = setupDefaults();
		seedProjectFiles();

		await runMultiProject({
			cli: makeCli({ files: ["src/client/a.spec.ts"] }),
			config,
			rawProjects: [makeProjectEntry("client")],
		});

		expect(mocks.narrowConfigByFiles).toHaveBeenCalledWith(expect.any(Object), [
			"src/client/a.spec.ts",
		]);
	});

	it("should resolve setupFiles per-project via discovery helper", async () => {
		expect.assertions(1);

		const { config } = setupDefaults();
		mocks.resolveAllProjects.mockResolvedValue([
			makeResolvedProject({
				config: makeConfig({ setupFiles: ["./setup.ts"] }),
				displayName: "client",
				include: ["src/client/**/*.spec.ts"],
			}),
		]);
		mocks.createSetupResolver.mockReturnValue((input) => `resolved:${input}`);
		seedProjectFiles();

		await runMultiProject({
			cli: makeCli(),
			config,
			rawProjects: [makeProjectEntry("client")],
		});

		const job = mocks.executeBackend.mock.calls[0]?.[1][0];

		expect(job?.config.setupFiles).toStrictEqual(["resolved:./setup.ts"]);
	});

	it("should preserve backend errors and still close the backend", async () => {
		expect.assertions(2);

		const { config } = setupDefaults();
		const backend = makeBackend("studio");
		mocks.resolveBackend.mockResolvedValueOnce(backend);
		seedProjectFiles();
		const error = new Error("backend failed");
		mocks.executeBackend.mockRejectedValueOnce(error);

		await expect(
			runMultiProject({
				cli: makeCli(),
				config,
				rawProjects: [makeProjectEntry("client")],
			}),
		).rejects.toBe(error);
		expect(backend.close).toHaveBeenCalledOnce();
	});
});
