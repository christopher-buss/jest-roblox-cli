import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import * as path from "node:path";
import process from "node:process";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { resolveBackend } from "../backends/auto.ts";
import type { Backend } from "../backends/interface.ts";
import { filterProjectsByFiles } from "../config/filter-projects-by-files.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import { resolveAllProjects } from "../config/projects.ts";
import {
	type CliOptions,
	DEFAULT_CONFIG,
	type InlineProjectConfig,
	type ResolvedConfig,
} from "../config/schema.ts";
import { createSetupResolver } from "../config/setup-resolver.ts";
import {
	cleanLeftoverStubs,
	generateProjectStubs,
	hasUserAuthoredConfig,
	syncStubsToShadowDirectory,
} from "../config/stubs.ts";
import { MANIFEST_VERSION } from "../coverage/manifest.ts";
import { prepareCoverage } from "../coverage/prepare.ts";
import { type ExecuteResult, runProjects } from "../executor.ts";
import { synthesize } from "../staging/synthesizer.ts";
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
vi.mock(import("../config/filter-projects-by-files"));
vi.mock(import("../utils/rojo-builder"));
vi.mock(import("../executor"));
vi.mock(import("../coverage/prepare"));
vi.mock(import("../typecheck/runner"));
vi.mock(import("../staging/synthesizer"));

const mocks = {
	buildWithRojo: vi.mocked(buildWithRojo),
	cleanLeftoverStubs: vi.mocked(cleanLeftoverStubs),
	createSetupResolver: vi.mocked(createSetupResolver),
	filterProjectsByFiles: vi.mocked(filterProjectsByFiles),
	generateProjectStubs: vi.mocked(generateProjectStubs),
	hasUserAuthoredConfig: vi.mocked(hasUserAuthoredConfig),
	prepareCoverage: vi.mocked(prepareCoverage),
	resolveAllProjects: vi.mocked(resolveAllProjects),
	resolveBackend: vi.mocked(resolveBackend),
	runProjects: vi.mocked(runProjects),
	runTypecheck: vi.mocked(runTypecheck),
	syncStubsToShadowDirectory: vi.mocked(syncStubsToShadowDirectory),
	synthesize: vi.mocked(synthesize),
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
			uploadMs: 50,
		},
		...overrides,
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
		exclude: [],
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
	// `cleanLeftoverStubs` returns the list of paths it cleaned. Mock to
	// empty for tests that don't seed leftover stubs.
	mocks.cleanLeftoverStubs.mockReturnValue([]);
	// Default: no user-authored configs exist on disk. Tests that want to
	// exercise the user-authored skip branches override per-call.
	mocks.hasUserAuthoredConfig.mockReturnValue(false);
	mocks.synthesize.mockReturnValue(
		JSON.stringify({ name: "synth", tree: { $className: "DataModel" } }),
	);
	// The Place Builder hashes the `.rbxl` after building, so the rojo mock
	// must leave an artifact on disk for `hashFile` to read.
	mocks.buildWithRojo.mockImplementation((_projectPath, outputPath) => {
		vol.mkdirSync(path.dirname(outputPath), { recursive: true });
		vol.writeFileSync(outputPath, "RBXL");
	});
	mocks.resolveBackend.mockResolvedValue(makeBackend("studio"));
	mocks.runProjects.mockImplementation(async (input) => {
		return {
			backendTiming: { executionMs: 100, uploadMs: 50 },
			results: input.projects.map(() => makeExecuteResult()),
		};
	});
	mocks.filterProjectsByFiles.mockImplementation((projectList, files) => {
		return projectList.map((project) => ({ matchingFiles: [...files], project }));
	});
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

	it("should emit the run header to stdout before running jobs", async () => {
		expect.assertions(1);

		const { config } = setupDefaults();
		seedProjectFiles();
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

		await runMultiProject({
			cli: makeCli(),
			config,
			rawProjects: [makeProjectEntry("client")],
		});

		expect(stdout).toHaveBeenCalledWith(expect.stringContaining(" RUN "));
	});

	it("should not emit the run header when there are no runtime jobs", async () => {
		expect.assertions(1);

		const { config } = setupDefaults();
		// Don't seed any test files — no runtime jobs are produced.
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

		await runMultiProject({
			cli: makeCli(),
			config,
			rawProjects: [makeProjectEntry("client")],
		});

		expect(stdout).not.toHaveBeenCalledWith(expect.stringContaining(" RUN "));
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

	it("should default rojoProject for the open-cloud synthesizer build when unset", async () => {
		expect.assertions(1);

		const { config } = setupDefaults({ rojoProject: undefined });
		mocks.resolveBackend.mockResolvedValueOnce(makeBackend("open-cloud"));
		seedProjectFiles();

		await runMultiProject({
			cli: makeCli(),
			config,
			rawProjects: [makeProjectEntry("client")],
		});

		// The synthesizer is called with the user's rojoProjectPath; when
		// the config's `rojoProject` is undefined the path should resolve
		// to `<rootDir>/default.project.json`.
		const synthArgs = mocks.synthesize.mock.calls[0]![0];

		expect(synthArgs.packages[0]!.rojoProjectPath).toContain("default.project.json");
	});

	it("should call buildWithRojo when coverage is disabled and backend is open-cloud", async () => {
		expect.assertions(2);

		const { config } = setupDefaults();
		// Studio skips the place build (it uses the runtime injector).
		// Place build only runs for open-cloud + no-coverage.
		mocks.resolveBackend.mockResolvedValueOnce(makeBackend("open-cloud"));
		seedProjectFiles();

		await runMultiProject({
			cli: makeCli(),
			config,
			rawProjects: [makeProjectEntry("client")],
		});

		expect(mocks.buildWithRojo).toHaveBeenCalledOnce();
		expect(mocks.synthesize).toHaveBeenCalledOnce();
	});

	it("should skip buildWithRojo entirely when backend is studio", async () => {
		expect.assertions(2);

		const { config } = setupDefaults();
		// Default backend in setupDefaults is studio; reaffirm explicitly.
		mocks.resolveBackend.mockResolvedValueOnce(makeBackend("studio"));
		seedProjectFiles();

		await runMultiProject({
			cli: makeCli(),
			config,
			rawProjects: [makeProjectEntry("client")],
		});

		expect(mocks.buildWithRojo).not.toHaveBeenCalled();
		expect(mocks.synthesize).not.toHaveBeenCalled();
	});

	it("should skip buildWithRojo and prepare coverage when collectCoverage is true", async () => {
		expect.assertions(3);

		const { config } = setupDefaults({ collectCoverage: true });
		mocks.prepareCoverage.mockReturnValue({
			buildId: "test-build-id",
			coveragePlace: { hash: "cov-hash", path: "/coverage/game.rbxl" },
			files: {},
			manifest: {
				buildId: "test-build-id",
				files: {},
				generatedAt: new Date().toISOString(),
				instrumenterVersion: 1,
				luauRoots: [],
				nonInstrumentedFiles: {},
				placeFilePath: "/coverage/game.rbxl",
				shadowDir: ".jest-roblox/coverage",
				version: MANIFEST_VERSION,
			},
			placeFile: "/coverage/game.rbxl",
			rebuilt: true,
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
				buildId: "test-build-id",
				coveragePlace: { hash: "cov-hash", path: "/coverage/game.rbxl" },
				files: {},
				manifest: {
					buildId: "test-build-id",
					files: {},
					generatedAt: new Date().toISOString(),
					instrumenterVersion: 1,
					luauRoots: [],
					nonInstrumentedFiles: {},
					placeFilePath: "/coverage/game.rbxl",
					shadowDir: ".jest-roblox/coverage",
					version: MANIFEST_VERSION,
				},
				placeFile: "/coverage/game.rbxl",
				rebuilt: true,
			};
		});
		seedProjectFiles();

		await runMultiProject({
			cli: makeCli(),
			config,
			rawProjects: [makeProjectEntry("client")],
		});

		// Coverage sync source is the cacheRoot, not rootDir. Stubs live
		// in `.jest-roblox/cache`; the coverage shadow mirrors from there.
		expect(mocks.syncStubsToShadowDirectory).toHaveBeenCalledWith(
			expect.any(Array),
			expect.stringMatching(/[\\/]\.jest-roblox[\\/]cache$/),
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

		const { config } = setupDefaults({ typecheck: { enabled: true } });
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

		expect(mocks.runTypecheck).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				files: expect.arrayContaining([expect.stringMatching(/a\.spec-d\.ts$/)]) as unknown,
			}),
		);
		expect(result.typecheckResult).toBeDefined();
	});

	it("should check projects with distinct typecheck tsconfigs against their own", async () => {
		expect.assertions(3);

		const { config } = setupDefaults({ typecheck: { enabled: true } });
		mocks.runTypecheck.mockReturnValue(makeJestResult());
		vol.mkdirSync("/test/src/client", { recursive: true });
		vol.writeFileSync("/test/src/client/a.spec-d.ts", "");
		vol.mkdirSync("/test/src/server", { recursive: true });
		vol.writeFileSync("/test/src/server/b.spec-d.ts", "");
		mocks.resolveAllProjects.mockResolvedValue([
			makeResolvedProject({
				displayName: "client",
				include: ["src/client/**/*.spec.ts"],
				typecheck: { tsconfig: "tsconfig.client.json" },
			}),
			makeResolvedProject({
				displayName: "server",
				include: ["src/server/**/*.spec.ts"],
				outDir: "out/server",
				rojoMounts: [{ dataModelPath: "ServerScriptService/server", fsPath: "out/server" }],
				typecheck: { tsconfig: "tsconfig.server.json" },
			}),
		]);

		await runMultiProject({
			cli: makeCli(),
			config,
			rawProjects: [makeProjectEntry("client"), makeProjectEntry("server")],
		});

		expect(mocks.runTypecheck).toHaveBeenCalledTimes(2);
		expect(mocks.runTypecheck).toHaveBeenCalledWith(
			expect.objectContaining({
				files: ["src/client/a.spec-d.ts"],
				tsconfig: "tsconfig.client.json",
			}),
		);
		expect(mocks.runTypecheck).toHaveBeenCalledWith(
			expect.objectContaining({
				files: ["src/server/b.spec-d.ts"],
				tsconfig: "tsconfig.server.json",
			}),
		);
	});

	it("should derive spec-d type tests from a runtime-only include", async () => {
		expect.assertions(1);

		const { config } = setupDefaults({ typecheck: { enabled: true } });
		mocks.runTypecheck.mockReturnValue(makeJestResult());
		vol.mkdirSync("/test/src/client", { recursive: true });
		vol.writeFileSync("/test/src/client/a.spec.ts", "");
		vol.writeFileSync("/test/src/client/a.spec-d.ts", "");
		mocks.resolveAllProjects.mockResolvedValue([
			makeResolvedProject({
				displayName: "client",
				include: ["src/client/**/*.spec.ts"],
			}),
		]);

		await runMultiProject({
			cli: makeCli(),
			config,
			rawProjects: [makeProjectEntry("client")],
		});

		expect(mocks.runTypecheck).toHaveBeenCalledWith(
			expect.objectContaining({
				files: expect.arrayContaining([expect.stringMatching(/a\.spec-d\.ts$/)]) as unknown,
			}),
		);
	});

	it("should run typecheck-only without runtime jobs", async () => {
		expect.assertions(2);

		const { config } = setupDefaults({ typecheck: { enabled: true, only: true } });
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

		expect(mocks.runProjects).not.toHaveBeenCalled();
		expect(result.typecheckResult).toBeDefined();
	});

	it("should not discover type tests when include is set but typecheck is disabled", async () => {
		expect.assertions(1);

		const { config } = setupDefaults({
			typecheck: { include: ["src/client/**/*.spec-d.ts"] },
		});
		vol.mkdirSync("/test/src/client", { recursive: true });
		vol.writeFileSync("/test/src/client/a.spec.ts", "");
		vol.writeFileSync("/test/src/client/a.spec-d.ts", "");
		mocks.resolveAllProjects.mockResolvedValue([
			makeResolvedProject({ displayName: "client", include: ["src/client/**/*.spec.ts"] }),
		]);

		await runMultiProject({
			cli: makeCli(),
			config,
			rawProjects: [makeProjectEntry("client")],
		});

		expect(mocks.runTypecheck).not.toHaveBeenCalled();
	});

	it("should use an explicit typecheck include instead of deriving", async () => {
		expect.assertions(1);

		const { config } = setupDefaults({
			typecheck: { enabled: true, include: ["src/shared/**/*.spec-d.ts"] },
		});
		mocks.runTypecheck.mockReturnValue(makeJestResult());
		vol.mkdirSync("/test/src/client", { recursive: true });
		vol.writeFileSync("/test/src/client/a.spec.ts", "");
		vol.mkdirSync("/test/src/shared", { recursive: true });
		vol.writeFileSync("/test/src/shared/x.spec-d.ts", "");
		mocks.resolveAllProjects.mockResolvedValue([
			makeResolvedProject({ displayName: "client", include: ["src/client/**/*.spec.ts"] }),
		]);

		await runMultiProject({
			cli: makeCli(),
			config,
			rawProjects: [makeProjectEntry("client")],
		});

		expect(mocks.runTypecheck).toHaveBeenCalledWith(
			expect.objectContaining({
				files: expect.arrayContaining([expect.stringMatching(/x\.spec-d\.ts$/)]) as unknown,
			}),
		);
	});

	it("should drop type test files matching a typecheck exclude glob", async () => {
		expect.assertions(2);

		const { config } = setupDefaults({
			typecheck: { enabled: true, exclude: ["src/client/**/*.gen.spec-d.ts"] },
		});
		mocks.runTypecheck.mockReturnValue(makeJestResult());
		vol.mkdirSync("/test/src/client", { recursive: true });
		vol.writeFileSync("/test/src/client/a.spec.ts", "");
		vol.writeFileSync("/test/src/client/a.spec-d.ts", "");
		vol.writeFileSync("/test/src/client/a.gen.spec-d.ts", "");
		mocks.resolveAllProjects.mockResolvedValue([
			makeResolvedProject({ displayName: "client", include: ["src/client/**/*.spec.ts"] }),
		]);

		await runMultiProject({
			cli: makeCli(),
			config,
			rawProjects: [makeProjectEntry("client")],
		});

		const { files } = mocks.runTypecheck.mock.calls[0]![0];

		expect(files).toContain("src/client/a.spec-d.ts");
		expect(files).not.toContain("src/client/a.gen.spec-d.ts");
	});

	it("should not apply typecheck exclude to explicitly named positional files", async () => {
		expect.assertions(1);

		const { config } = setupDefaults({
			typecheck: { enabled: true, exclude: ["src/client/**/*.spec-d.ts"] },
		});
		mocks.runTypecheck.mockReturnValue(makeJestResult());
		vol.mkdirSync("/test/src/client", { recursive: true });
		vol.writeFileSync("/test/src/client/a.spec-d.ts", "");
		mocks.resolveAllProjects.mockResolvedValue([
			makeResolvedProject({ displayName: "client", include: ["src/client/**/*.spec.ts"] }),
		]);

		await runMultiProject({
			cli: makeCli({ files: ["src/client/a.spec-d.ts"] }),
			config,
			rawProjects: [makeProjectEntry("client")],
		});

		expect(mocks.runTypecheck).toHaveBeenCalledWith(
			expect.objectContaining({
				files: expect.arrayContaining([expect.stringMatching(/a\.spec-d\.ts$/)]) as unknown,
			}),
		);
	});

	it("should drop runtime test files matching a per-project exclude glob", async () => {
		expect.assertions(1);

		const { config } = setupDefaults();
		vol.mkdirSync("/test/src/client", { recursive: true });
		vol.writeFileSync("/test/src/client/a.spec.ts", "");
		vol.writeFileSync("/test/src/client/a.gen.spec.ts", "");
		mocks.resolveAllProjects.mockResolvedValue([
			makeResolvedProject({
				displayName: "client",
				exclude: ["**/*.gen.spec.ts"],
				include: ["src/client/**/*.spec.ts"],
			}),
		]);

		await runMultiProject({
			cli: makeCli(),
			config,
			rawProjects: [makeProjectEntry("client")],
		});

		const { projects } = mocks.runProjects.mock.calls[0]![0];

		expect(projects[0]!.testFiles).toStrictEqual(["src/client/a.spec.ts"]);
	});

	// AC #2: with coverage on, derivation must keep `-d` globs out of
	// `project.include`. `deriveCoverageFromIncludes` runs `inferSourceExtension`
	// over `project.include` — a leaked `*.spec-d.ts` would throw "Cannot infer
	// source extension", so completing the run proves the invariant holds.
	it("should run coverage with typecheck enabled without inferring a -d source extension", async () => {
		expect.assertions(2);

		const { config } = setupDefaults({
			collectCoverage: true,
			typecheck: { enabled: true },
		});
		mocks.prepareCoverage.mockReturnValue({
			buildId: "test-build-id",
			coveragePlace: { hash: "cov-hash", path: "/coverage/game.rbxl" },
			files: {},
			manifest: {
				buildId: "test-build-id",
				files: {},
				generatedAt: new Date().toISOString(),
				instrumenterVersion: 1,
				luauRoots: [],
				nonInstrumentedFiles: {},
				placeFilePath: "/coverage/game.rbxl",
				shadowDir: ".jest-roblox/coverage",
				version: MANIFEST_VERSION,
			},
			placeFile: "/coverage/game.rbxl",
			rebuilt: true,
		});
		mocks.runTypecheck.mockReturnValue(makeJestResult());
		vol.mkdirSync("/test/src/client", { recursive: true });
		vol.writeFileSync("/test/src/client/a.spec.ts", "");
		vol.writeFileSync("/test/src/client/a.spec-d.ts", "");
		mocks.resolveAllProjects.mockResolvedValue([
			makeResolvedProject({ displayName: "client", include: ["src/client/**/*.spec.ts"] }),
		]);

		const result = await runMultiProject({
			cli: makeCli(),
			config,
			rawProjects: [makeProjectEntry("client")],
		});

		expect(result.mode).toBe("multi");
		expect(result.typecheckResult).toBeDefined();
	});

	it("should merge coverage data and source mappers across project results", async () => {
		expect.assertions(2);

		const { config } = setupDefaults();
		seedProjectFiles();

		mocks.runProjects.mockImplementation(async (input) => {
			return {
				backendTiming: { executionMs: 100, uploadMs: 50 },
				results: input.projects.map((project) => {
					const tag = project.displayName ?? "";
					return makeExecuteResult({
						coverageData: { [`${tag}.luau`]: { s: { "0": 1 } } },
						sourceMapper: {
							mapFailureMessage: (message) => `[${tag}] ${message}`,
							mapFailureWithLocations: (message) => ({ locations: [], message }),
							resolveDisplayPath: (testFilePath) => testFilePath,
							resolveTestFilePath: () => {},
						},
					});
				}),
			};
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

		const openCloudCall = mocks.runProjects.mock.calls[0];

		expect(openCloudCall?.[0].parallel).toBe(2);

		mocks.runProjects.mockClear();
		mocks.resolveBackend.mockResolvedValueOnce(makeBackend("studio"));
		await runMultiProject({
			cli: makeCli(),
			config,
			rawProjects: [makeProjectEntry("client")],
		});

		const studioCall = mocks.runProjects.mock.calls[0];

		expect(studioCall?.[0].parallel).toBeUndefined();
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

		const { projects } = mocks.runProjects.mock.calls[0]![0];

		expect(projects[0]!.config.testPathPattern).toBe("(a\\.spec)");
	});

	it("should forward a basename pattern when --testPathPattern is a filesystem path", async () => {
		expect.assertions(1);

		const { config } = setupDefaults();
		mocks.resolveAllProjects.mockResolvedValue([
			makeResolvedProject({
				config: makeConfig({ testPathPattern: "src/client/a.spec" }),
				displayName: "client",
				outDir: "out/client",
			}),
		]);
		seedProjectFiles();

		await runMultiProject({
			cli: makeCli({ testPathPattern: "src/client/a.spec" }),
			config: { ...config, testPathPattern: "src/client/a.spec" },
			rawProjects: [makeProjectEntry("client")],
		});

		const { projects } = mocks.runProjects.mock.calls[0]![0];

		expect(projects[0]!.config.testPathPattern).toBe("(a\\.spec)");
	});

	it("should call filterProjectsByFiles with cli files when --project is absent", async () => {
		expect.assertions(1);

		const { config } = setupDefaults();
		seedProjectFiles();
		mocks.filterProjectsByFiles.mockImplementation((projectList, files) => {
			return projectList
				.filter((project) => project.displayName === "server")
				.map((project) => ({ matchingFiles: [...files], project }));
		});

		const result = await runMultiProject({
			cli: makeCli({ files: ["src/server/b.spec.ts"] }),
			config,
			rawProjects: [makeProjectEntry("client"), makeProjectEntry("server")],
		});

		expect(result.projectResults.map((entry) => entry.displayName)).toStrictEqual(["server"]);
	});

	it("should feed each project only the cli files filterProjectsByFiles paired with it", async () => {
		expect.assertions(2);

		const { config } = setupDefaults();
		seedProjectFiles();
		mocks.filterProjectsByFiles.mockImplementation((projectList) => {
			return projectList.map((project) => {
				return {
					matchingFiles: project.displayName === "client" ? ["src/client/a.spec.ts"] : [],
					project,
				};
			});
		});

		await runMultiProject({
			cli: makeCli({ files: ["src/client/a.spec.ts", "src/server/b.spec.ts"] }),
			config,
			rawProjects: [makeProjectEntry("client"), makeProjectEntry("server")],
		});

		// Each selected project narrows by its own file subset: client matched
		// a.spec, so its Luau pattern is `(a\.spec)`; server matched nothing, so
		// it is not narrowed (runs all its testMatch files).
		const { projects } = mocks.runProjects.mock.calls[0]![0];

		expect(projects[0]!.config.testPathPattern).toBe("(a\\.spec)");
		expect(projects[1]!.config.testPathPattern).toBeUndefined();
	});

	it("should pass cli files and rootDir through to filterProjectsByFiles", async () => {
		expect.assertions(1);

		const { config } = setupDefaults();
		seedProjectFiles();

		await runMultiProject({
			cli: makeCli({ files: ["src/server/b.spec.ts"] }),
			config,
			rawProjects: [makeProjectEntry("client"), makeProjectEntry("server")],
		});

		expect(mocks.filterProjectsByFiles).toHaveBeenCalledWith(
			expect.any(Array),
			["src/server/b.spec.ts"],
			"/test",
		);
	});

	it("should propagate filterProjectsByFiles errors when no project owns the file", async () => {
		expect.assertions(1);

		const { config } = setupDefaults();
		seedProjectFiles();
		mocks.filterProjectsByFiles.mockImplementation(() => {
			throw new Error("No project contains the requested file(s)");
		});

		await expect(
			runMultiProject({
				cli: makeCli({ files: ["src/shared/x.spec.ts"] }),
				config,
				rawProjects: [makeProjectEntry("client"), makeProjectEntry("server")],
			}),
		).rejects.toThrow(/No project contains the requested file/);
	});

	it("should skip filterProjectsByFiles when --project is set even if files are passed", async () => {
		expect.assertions(2);

		const { config } = setupDefaults();
		seedProjectFiles();

		const result = await runMultiProject({
			cli: makeCli({ files: ["src/server/b.spec.ts"], project: ["client"] }),
			config,
			rawProjects: [makeProjectEntry("client"), makeProjectEntry("server")],
		});

		expect(mocks.filterProjectsByFiles).not.toHaveBeenCalled();
		expect(result.projectResults.map((entry) => entry.displayName)).toStrictEqual(["client"]);
	});

	it("should skip filterProjectsByFiles when no cli files are passed", async () => {
		expect.assertions(1);

		const { config } = setupDefaults();
		seedProjectFiles();

		await runMultiProject({
			cli: makeCli(),
			config,
			rawProjects: [makeProjectEntry("client"), makeProjectEntry("server")],
		});

		expect(mocks.filterProjectsByFiles).not.toHaveBeenCalled();
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

		const project = mocks.runProjects.mock.calls[0]?.[0].projects[0];

		expect(project?.config.setupFiles).toStrictEqual(["resolved:./setup.ts"]);
	});

	it("should preserve backend errors and still close the backend", async () => {
		expect.assertions(2);

		const { config } = setupDefaults();
		const backend = makeBackend("studio");
		mocks.resolveBackend.mockResolvedValueOnce(backend);
		seedProjectFiles();
		const error = new Error("backend failed");
		mocks.runProjects.mockRejectedValueOnce(error);

		await expect(
			runMultiProject({
				cli: makeCli(),
				config,
				rawProjects: [makeProjectEntry("client")],
			}),
		).rejects.toBe(error);
		expect(backend.close).toHaveBeenCalledOnce();
	});

	it("should emit a stderr notice listing the leftover stubs cleaned", async () => {
		expect.assertions(2);

		const { config } = setupDefaults();
		mocks.cleanLeftoverStubs.mockReturnValueOnce([
			"/test/src/client/jest.config.luau",
			"/test/src/server/jest.config.luau",
		]);
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		seedProjectFiles();

		await runMultiProject({
			cli: makeCli(),
			config,
			rawProjects: [makeProjectEntry("client")],
		});

		expect(stderr).toHaveBeenCalledOnce();

		const written = stderr.mock.calls[0]![0] as string;

		expect(written).toContain("cleaned 2 leftover stub(s)");

		stderr.mockRestore();
	});

	it("should skip stubMounts and runtimeInjectionPaths for mounts with user-authored configs", async () => {
		expect.assertions(2);

		const { config } = setupDefaults();
		mocks.resolveBackend.mockResolvedValueOnce(makeBackend("open-cloud"));
		// Pretend the user authored a config at every mount on disk.
		mocks.hasUserAuthoredConfig.mockReturnValue(true);
		seedProjectFiles();

		await runMultiProject({
			cli: makeCli(),
			config,
			rawProjects: [makeProjectEntry("client")],
		});

		// Synthesizer still runs (it's open-cloud + no-coverage) but with
		// zero stubMounts because hasUserAuthoredConfig was true at every
		// mount. The synth.project.json would contain no `$path` injections.
		const synthArgs = mocks.synthesize.mock.calls[0]![0];

		expect(synthArgs.packages[0]!.stubMounts).toStrictEqual([]);

		// `runtimeInjectionPaths` on the job is also empty for the same reason.
		const jobs = mocks.runProjects.mock.calls[0]![0].projects;

		expect(jobs[0]!.runtimeInjectionPaths).toStrictEqual([]);
	});
});
