import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import * as path from "node:path";
import process from "node:process";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import type { Backend, BackendOptions, BackendResult } from "../backends/interface.ts";
import type { CliOptions, ResolvedConfig } from "../config/schema.ts";
import { DEFAULT_CONFIG } from "../config/schema.ts";
import { runTypecheck } from "../typecheck/runner.ts";
import type { JestResult } from "../types/jest-result.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { runSingleProject } from "./single.ts";
import type { RunOptions } from "./types.ts";

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, cpSync: memfs.vol.cpSync.bind(memfs.vol), default: memfs.fs });
});

vi.mock(import("get-tsconfig"), async (importOriginal) => {
	const actual = await importOriginal();
	const nodeFs = await import("node:fs");
	const nodePath = await import("node:path");
	const { tsconfigShapeSchema } = await import("../config/tsconfig-schema.ts");
	return fromAny({
		...actual,
		getTsconfig: (searchPath: string, configName = "tsconfig.json") => {
			const resolved = nodePath.resolve(searchPath);
			const filePath = nodePath.join(resolved, configName);
			try {
				const content = nodeFs.readFileSync(filePath, "utf-8");
				return { config: tsconfigShapeSchema.assert(JSON.parse(content)), path: filePath };
			} catch {
				return null;
			}
		},
	});
});

vi.mock(import("node:child_process"), async (importOriginal) => {
	const actual = await importOriginal();
	return fromAny({ ...actual, execFileSync: vi.fn<() => string>(() => "") });
});

vi.mock(import("../coverage-pipeline/instrumenter"));
vi.mock(import("../utils/rojo-builder"));
vi.mock(import("../backends/auto"));
vi.mock(import("../config/setup-resolver"));
vi.mock(import("../typecheck/runner"));

interface BackendCapture {
	closeCalls: number;
	runCalls: number;
	runOptions?: BackendOptions;
}

const PROJECT_ROOT = process.cwd();

function seedRoot(): void {
	vol.mkdirSync(PROJECT_ROOT, { recursive: true });
}

seedRoot();

function resetVol(): void {
	onTestFinished(() => {
		vol.reset();
		seedRoot();
	});
}

function makeJestResult(overrides: Partial<JestResult> = {}): JestResult {
	return {
		numFailedTests: 0,
		numPassedTests: 1,
		numPendingTests: 0,
		numTotalTests: 1,
		startTime: 1000,
		success: true,
		testResults: [
			{
				numFailingTests: 0,
				numPassingTests: 1,
				numPendingTests: 0,
				testFilePath: "src/test.spec.ts",
				testResults: [
					{
						ancestorTitles: [],
						duration: 5,
						failureMessages: [],
						fullName: "passes",
						status: "passed",
						title: "passes",
					},
				],
			},
		],
		...overrides,
	};
}

function createFakeBackend(
	result: JestResult = makeJestResult(),
	capture?: BackendCapture,
): Backend {
	return {
		close: () => {
			if (capture !== undefined) {
				capture.closeCalls += 1;
			}
		},
		kind: "studio",
		runTests: async (options): Promise<BackendResult> => {
			if (capture !== undefined) {
				capture.runCalls += 1;
				capture.runOptions = options;
			}

			return {
				rawResults: [{ entry: { jestOutput: JSON.stringify(result) } }],
				timing: { executionMs: 1, uploadMs: 0 },
			};
		},
	};
}

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return {
		...DEFAULT_CONFIG,
		rootDir: PROJECT_ROOT,
		testMatch: ["**/*.spec.ts"],
		testPathIgnorePatterns: [],
		...overrides,
	};
}

function makeOptions(
	configOverrides: Partial<ResolvedConfig> = {},
	cliOverrides: Partial<CliOptions> = {},
): RunOptions {
	return { cli: { ...cliOverrides }, config: makeConfig(configOverrides) };
}

async function setupBackend(backend: Backend = createFakeBackend()): Promise<void> {
	const { resolveBackend } = await import("../backends/auto");
	vi.mocked(resolveBackend).mockResolvedValue(backend);
}

function rootedPath(relative: string): string {
	return path.join(PROJECT_ROOT, relative);
}

function seedFile(relative: string, contents = ""): void {
	const target = rootedPath(relative);
	vol.mkdirSync(path.dirname(target), { recursive: true });
	vol.writeFileSync(target, contents);
}

describe(runSingleProject, () => {
	describe("when no test files match", () => {
		it("should return validationExitCode 2 when passWithNoTests is false", async () => {
			expect.assertions(2);

			resetVol();
			const consoleError = vi.spyOn(console, "error").mockReturnValue(undefined);
			await setupBackend();

			const result = await runSingleProject(makeOptions({ passWithNoTests: false }));

			expect(result).toStrictEqual({
				mode: "single",
				preCoverageMs: 0,
				validationExitCode: 2,
			});
			expect(consoleError).toHaveBeenCalledWith("No test files found");
		});

		it("should return success when passWithNoTests is true", async () => {
			expect.assertions(1);

			resetVol();
			await setupBackend();

			const result = await runSingleProject(makeOptions({ passWithNoTests: true }));

			expect(result).toStrictEqual({ mode: "single", preCoverageMs: 0 });
		});
	});

	describe("when files exist but none match the selected mode", () => {
		it("should return validationExitCode 2 when typecheckOnly excludes all runtime files", async () => {
			expect.assertions(2);

			resetVol();
			seedFile("src/a.spec.ts");
			const consoleError = vi.spyOn(console, "error").mockReturnValue(undefined);
			await setupBackend();

			const result = await runSingleProject(
				makeOptions({ passWithNoTests: false, typecheck: { enabled: true, only: true } }),
			);

			expect(result).toStrictEqual({
				mode: "single",
				preCoverageMs: 0,
				validationExitCode: 2,
			});
			expect(consoleError).toHaveBeenCalledWith("No test files found for the selected mode");
		});

		it("should return success when passWithNoTests is true and no files match the mode", async () => {
			expect.assertions(1);

			resetVol();
			seedFile("src/a.spec.ts");
			await setupBackend();

			const result = await runSingleProject(
				makeOptions({ passWithNoTests: true, typecheck: { enabled: true, only: true } }),
			);

			expect(result).toStrictEqual({ mode: "single", preCoverageMs: 0 });
		});
	});

	describe("when running runtime tests only", () => {
		it("should execute runtime tests via the backend and return the result", async () => {
			expect.assertions(4);

			resetVol();
			seedFile("src/a.spec.ts");
			const capture: BackendCapture = { closeCalls: 0, runCalls: 0 };
			await setupBackend(createFakeBackend(makeJestResult(), capture));

			const result = await runSingleProject(makeOptions());

			expect(result.mode).toBe("single");
			expect(result.runtimeResult?.exitCode).toBe(0);
			expect(capture.runCalls).toBe(1);
			expect(capture.closeCalls).toBe(1);
		});

		it("should emit the run header to stdout before running", async () => {
			expect.assertions(1);

			resetVol();
			seedFile("src/a.spec.ts");
			const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
			await setupBackend();

			await runSingleProject(makeOptions());

			expect(stdout).toHaveBeenCalledWith(expect.stringContaining(" RUN "));
		});

		it("should not emit the run header when silent", async () => {
			expect.assertions(1);

			resetVol();
			seedFile("src/a.spec.ts");
			const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
			await setupBackend();

			await runSingleProject(makeOptions({ silent: true }));

			expect(stdout).not.toHaveBeenCalledWith(expect.stringContaining(" RUN "));
		});

		it("should still close the backend when execute throws", async () => {
			expect.assertions(2);

			resetVol();
			seedFile("src/a.spec.ts");
			const capture: BackendCapture = { closeCalls: 0, runCalls: 0 };
			const backend: Backend = {
				close: () => {
					capture.closeCalls += 1;
				},
				kind: "studio",
				runTests: () => {
					throw new Error("boom");
				},
			};
			await setupBackend(backend);

			await expect(runSingleProject(makeOptions())).rejects.toThrow("boom");
			expect(capture.closeCalls).toBe(1);
		});

		it("should tolerate a backend without a close hook", async () => {
			expect.assertions(1);

			resetVol();
			seedFile("src/a.spec.ts");
			const backend: Backend = {
				kind: "studio",
				runTests: async (): Promise<BackendResult> => {
					return {
						rawResults: [{ entry: { jestOutput: JSON.stringify(makeJestResult()) } }],
						timing: { executionMs: 1, uploadMs: 0 },
					};
				},
			};
			await setupBackend(backend);

			const result = await runSingleProject(makeOptions());

			expect(result.runtimeResult?.exitCode).toBe(0);
		});

		it("should print the file count notice when only a subset is run", async () => {
			expect.assertions(1);

			resetVol();
			seedFile("src/keep.spec.ts");
			seedFile("src/skip.spec.ts");
			const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
			await setupBackend();

			await runSingleProject(makeOptions({ testPathPattern: "keep" }));

			expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Running"));
		});

		it("should suppress the file count notice when silent", async () => {
			expect.assertions(1);

			resetVol();
			seedFile("src/keep.spec.ts");
			seedFile("src/skip.spec.ts");
			const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
			await setupBackend();

			await runSingleProject(makeOptions({ silent: true, testPathPattern: "keep" }));

			expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining("Running"));
		});

		it("should suppress the file count notice when an agent formatter is active", async () => {
			expect.assertions(1);

			resetVol();
			seedFile("src/keep.spec.ts");
			seedFile("src/skip.spec.ts");
			const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
			await setupBackend();

			await runSingleProject(
				makeOptions({
					formatters: ["agent"],
					testPathPattern: "keep",
					verbose: false,
				}),
			);

			expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining("Running"));
		});

		it("should suppress the file count notice when a json formatter is active", async () => {
			expect.assertions(1);

			resetVol();
			seedFile("src/keep.spec.ts");
			seedFile("src/skip.spec.ts");
			const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
			await setupBackend();

			await runSingleProject(
				makeOptions({ formatters: [["json", {}]], testPathPattern: "keep" }),
			);

			expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining("Running"));
		});

		it("should still print the notice when an agent formatter pairs with verbose", async () => {
			expect.assertions(1);

			resetVol();
			seedFile("src/keep.spec.ts");
			seedFile("src/skip.spec.ts");
			const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
			await setupBackend();

			await runSingleProject(
				makeOptions({
					formatters: ["agent"],
					testPathPattern: "keep",
					verbose: true,
				}),
			);

			expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Running"));
		});
	});

	describe("when running typecheck-only", () => {
		it("should run typecheck and skip runtime when typecheckOnly is set", async () => {
			expect.assertions(2);

			resetVol();
			seedFile("src/a.spec-d.ts", "test('passes', () => {});");
			const capture: BackendCapture = { closeCalls: 0, runCalls: 0 };
			await setupBackend(createFakeBackend(makeJestResult(), capture));

			const result = await runSingleProject(
				makeOptions({
					testMatch: ["**/*.spec-d.ts"],
					typecheck: { enabled: true, only: true },
				}),
			);

			expect(result.runtimeResult).toBeUndefined();
			expect(capture.runCalls).toBe(0);
		});
	});

	describe("when a non-test source file has a type error", () => {
		it("should forward test.typecheck.ignoreSourceErrors to the typecheck runner", async () => {
			expect.assertions(1);

			resetVol();
			seedFile("src/a.spec-d.ts", "test('passes', () => {});");
			await setupBackend();
			vi.mocked(runTypecheck).mockResolvedValue(makeJestResult());

			await runSingleProject(
				makeOptions({
					testMatch: ["**/*.spec-d.ts"],
					typecheck: { enabled: true, ignoreSourceErrors: true, only: true },
				}),
			);

			expect(vi.mocked(runTypecheck)).toHaveBeenCalledWith(
				expect.objectContaining({ ignoreSourceErrors: true }),
			);
		});
	});

	describe("when running mixed (typecheck + runtime)", () => {
		it("should produce both a typecheckResult and a runtimeResult", async () => {
			expect.assertions(3);

			resetVol();
			seedFile("src/a.spec.ts");
			seedFile("src/b.spec-d.ts", "test('typed', () => {});");
			const capture: BackendCapture = { closeCalls: 0, runCalls: 0 };
			await setupBackend(createFakeBackend(makeJestResult(), capture));
			vi.mocked(runTypecheck).mockResolvedValue(makeJestResult());

			const result = await runSingleProject(
				makeOptions({
					testMatch: ["**/*.spec.ts", "**/*.spec-d.ts"],
					typecheck: { enabled: true },
				}),
			);

			expect(result.runtimeResult?.exitCode).toBe(0);
			expect(result.typecheckResult).toBeDefined();
			expect(capture.runCalls).toBe(1);
		});

		it("should run the typecheck pass concurrently with the runtime run", async () => {
			expect.assertions(2);

			resetVol();
			seedFile("src/a.spec.ts");
			seedFile("src/b.spec-d.ts", "test('typed', () => {});");

			let signalRuntimeStarted!: () => void;
			let signalTypecheckStarted!: () => void;
			const runtimeStarted = new Promise<void>((resolve) => {
				signalRuntimeStarted = resolve;
			});
			const typecheckStarted = new Promise<void>((resolve) => {
				signalTypecheckStarted = resolve;
			});

			const typecheckOutcome = makeJestResult({ numPassedTests: 7 });
			vi.mocked(runTypecheck).mockImplementation(async () => {
				signalTypecheckStarted();
				await runtimeStarted;
				return typecheckOutcome;
			});

			// The fake backend stands in for the network-bound runtime run; it
			// proceeds only once the typecheck has also started, so the run
			// completes solely when the two overlap (a strictly-after pass
			// would deadlock here).
			const backend: Backend = {
				close: () => {
					// no teardown needed
				},
				kind: "studio",
				runTests: async (): Promise<BackendResult> => {
					signalRuntimeStarted();
					await typecheckStarted;
					return {
						rawResults: [{ entry: { jestOutput: JSON.stringify(makeJestResult()) } }],
						timing: { executionMs: 1, uploadMs: 0 },
					};
				},
			};
			await setupBackend(backend);

			const result = await runSingleProject(
				makeOptions({ testMatch: ["**/*.spec.ts", "**/*.spec-d.ts"] }, { typecheck: true }),
			);

			// A resolved JestResult (not an un-awaited Promise) proves the pass
			// is awaited; completing at all proves it overlapped the runtime.
			expect(result.typecheckResult).toStrictEqual(typecheckOutcome);
			expect(result.runtimeResult).toBeDefined();
		});
	});

	describe("when typecheck is driven by CLI flags", () => {
		it("should run type and runtime tests when --typecheck is passed", async () => {
			expect.assertions(2);

			resetVol();
			seedFile("src/a.spec.ts");
			seedFile("src/b.spec-d.ts", "test('typed', () => {});");
			const capture: BackendCapture = { closeCalls: 0, runCalls: 0 };
			await setupBackend(createFakeBackend(makeJestResult(), capture));
			vi.mocked(runTypecheck).mockResolvedValue(makeJestResult());

			const result = await runSingleProject(
				makeOptions({ testMatch: ["**/*.spec.ts", "**/*.spec-d.ts"] }, { typecheck: true }),
			);

			expect(result.typecheckResult).toBeDefined();
			expect(result.runtimeResult).toBeDefined();
		});

		it("should suppress runtime tests when --typecheckOnly is passed", async () => {
			expect.assertions(2);

			resetVol();
			seedFile("src/a.spec.ts");
			seedFile("src/b.spec-d.ts", "test('typed', () => {});");
			const capture: BackendCapture = { closeCalls: 0, runCalls: 0 };
			await setupBackend(createFakeBackend(makeJestResult(), capture));

			const result = await runSingleProject(
				makeOptions(
					{ testMatch: ["**/*.spec.ts", "**/*.spec-d.ts"] },
					{ typecheckOnly: true },
				),
			);

			expect(result.runtimeResult).toBeUndefined();
			expect(capture.runCalls).toBe(0);
		});
	});

	describe("when collectCoverage is enabled", () => {
		it("should run prepareCoverage, time it, and override placeFile", async () => {
			expect.assertions(3);

			resetVol();
			seedFile("src/a.spec.ts");
			vol.mkdirSync(rootedPath("out-tsc/test"), { recursive: true });
			vol.writeFileSync(rootedPath("out-tsc/test/init.luau"), "local x = 1");
			vol.writeFileSync(
				rootedPath("default.project.json"),
				JSON.stringify({
					name: "test",
					tree: { $className: "DataModel", ReplicatedStorage: { $path: "out-tsc/test" } },
				}),
			);
			vol.writeFileSync(
				rootedPath("tsconfig.json"),
				JSON.stringify({ compilerOptions: { outDir: "out-tsc/test" } }),
			);

			const { instrumentRoot } = await import("../coverage-pipeline/instrumenter");
			vi.mocked(instrumentRoot).mockReturnValue({});
			const { buildWithRojo } = await import("../utils/rojo-builder");
			vi.mocked(buildWithRojo).mockImplementation((_projectPath, outputPath) => {
				vol.mkdirSync(path.dirname(outputPath), { recursive: true });
				vol.writeFileSync(outputPath, "RBXL");
			});

			const capture: BackendCapture = { closeCalls: 0, runCalls: 0 };
			await setupBackend(createFakeBackend(makeJestResult(), capture));

			const result = await runSingleProject(makeOptions({ collectCoverage: true }));

			expect(result.preCoverageMs).toBeGreaterThanOrEqual(0);
			expect(capture.runOptions?.jobs[0]?.config.placeFile).toContain("game.rbxl");
			expect(
				result.coverageArtifacts?.projects.map((project) => project.projectDataModelPath),
			).toContain("ReplicatedStorage");
		});

		it("should skip prepareCoverage when typecheckOnly is set", async () => {
			expect.assertions(2);

			resetVol();
			seedFile("src/a.spec-d.ts", "test('typed', () => {});");

			const { instrumentRoot } = await import("../coverage-pipeline/instrumenter");
			const instrumentMock = vi.mocked(instrumentRoot).mockReturnValue({});
			await setupBackend();

			const result = await runSingleProject(
				makeOptions({
					collectCoverage: true,
					testMatch: ["**/*.spec-d.ts"],
					typecheck: { enabled: true, only: true },
				}),
			);

			expect(result.preCoverageMs).toBe(0);
			expect(instrumentMock).not.toHaveBeenCalled();
		});

		it("should skip prepareCoverage when there are no runtime files", async () => {
			expect.assertions(1);

			resetVol();
			seedFile("src/a.spec-d.ts", "test('typed', () => {});");

			const { instrumentRoot } = await import("../coverage-pipeline/instrumenter");
			const instrumentMock = vi.mocked(instrumentRoot).mockReturnValue({});
			await setupBackend();

			await runSingleProject(
				makeOptions({
					collectCoverage: true,
					testMatch: ["**/*.spec-d.ts"],
					typecheck: { enabled: true },
				}),
			);

			expect(instrumentMock).not.toHaveBeenCalled();
		});
	});

	describe("when CLI files are supplied", () => {
		it("should narrow testPathPattern to a basename pattern via narrowForLuauRun", async () => {
			expect.assertions(1);

			resetVol();
			seedFile("src/a.spec.ts");
			const capture: BackendCapture = { closeCalls: 0, runCalls: 0 };
			await setupBackend(createFakeBackend(makeJestResult(), capture));

			await runSingleProject(makeOptions({}, { files: ["src/a.spec.ts"] }));

			expect(capture.runOptions?.jobs[0]?.config.testPathPattern).toBe("(a\\.spec)");
		});
	});

	describe("coverage display filter", () => {
		it("should expose a source-twin filter for a positional run", async () => {
			expect.assertions(2);

			resetVol();
			seedFile("src/a.spec.ts");
			await setupBackend(createFakeBackend(makeJestResult()));

			const result = await runSingleProject(makeOptions({}, { files: ["src/a.spec.ts"] }));

			const twin = normalizeWindowsPath(path.resolve(PROJECT_ROOT, "src/a.ts"));

			expect(result.coverageDisplayFilter?.(twin)).toBeTrue();
			expect(
				result.coverageDisplayFilter?.(
					normalizeWindowsPath(path.resolve(PROJECT_ROOT, "src/b.ts")),
				),
			).toBeFalse();
		});

		it("should leave the filter undefined on a bare run", async () => {
			expect.assertions(1);

			resetVol();
			seedFile("src/a.spec.ts");
			await setupBackend(createFakeBackend(makeJestResult()));

			const result = await runSingleProject(makeOptions({}));

			expect(result.coverageDisplayFilter).toBeUndefined();
		});
	});

	describe("when test.exclude is configured", () => {
		it("should drop runtime test files matching a global exclude glob", async () => {
			expect.assertions(1);

			resetVol();
			seedFile("src/a.spec.ts");
			seedFile("src/a.gen.spec.ts");
			const capture: BackendCapture = { closeCalls: 0, runCalls: 0 };
			await setupBackend(createFakeBackend(makeJestResult(), capture));

			await runSingleProject(makeOptions({ exclude: ["**/*.gen.spec.ts"] }));

			expect(capture.runOptions?.jobs[0]?.testFiles).toStrictEqual(["src/a.spec.ts"]);
		});
	});

	describe("when test.typecheck.exclude is configured", () => {
		it("should drop type test files matching a typecheck exclude glob", async () => {
			expect.assertions(2);

			resetVol();
			seedFile("src/a.spec-d.ts");
			seedFile("src/a.gen.spec-d.ts");
			await setupBackend();
			vi.mocked(runTypecheck).mockResolvedValue(makeJestResult());

			await runSingleProject(
				makeOptions({
					testMatch: ["**/*.spec-d.ts"],
					typecheck: { enabled: true, exclude: ["**/*.gen.spec-d.ts"] },
				}),
			);

			const { files } = vi.mocked(runTypecheck).mock.calls[0]![0];

			expect(files).toContain("src/a.spec-d.ts");
			expect(files).not.toContain("src/a.gen.spec-d.ts");
		});
	});

	describe("when --testPathPattern is a filesystem path", () => {
		it("should forward a basename pattern so Roblox-side Jest matches the Instance path", async () => {
			expect.assertions(1);

			resetVol();
			seedFile("src/server/modules/ecs/context.spec.ts");
			const capture: BackendCapture = { closeCalls: 0, runCalls: 0 };
			await setupBackend(createFakeBackend(makeJestResult(), capture));

			await runSingleProject(
				makeOptions({ testPathPattern: "src/server/modules/ecs/context.spec" }),
			);

			expect(capture.runOptions!.jobs[0]!.config.testPathPattern).toBe("(context\\.spec)");
		});
	});

	describe("when no filter is active", () => {
		it("should leave testPathPattern undefined so Luau runs all testMatch files", async () => {
			expect.assertions(1);

			resetVol();
			seedFile("src/a.spec.ts");
			const capture: BackendCapture = { closeCalls: 0, runCalls: 0 };
			await setupBackend(createFakeBackend(makeJestResult(), capture));

			await runSingleProject(makeOptions());

			expect(capture.runOptions!.jobs[0]!.config.testPathPattern).toBeUndefined();
		});
	});

	describe("when setup files are configured", () => {
		it("should resolve setupFiles paths via the setup resolver", async () => {
			expect.assertions(1);

			resetVol();
			seedFile("src/a.spec.ts");
			const { createSetupResolver } = await import("../config/setup-resolver");
			vi.mocked(createSetupResolver).mockReturnValue((input) => `resolved:${input}`);
			const capture: BackendCapture = { closeCalls: 0, runCalls: 0 };
			await setupBackend(createFakeBackend(makeJestResult(), capture));

			await runSingleProject(makeOptions({ setupFiles: ["./setup.ts"] }));

			expect(capture.runOptions?.jobs[0]?.config.setupFiles).toStrictEqual([
				"resolved:./setup.ts",
			]);
		});

		it("should resolve setupFilesAfterEnv paths via the setup resolver", async () => {
			expect.assertions(1);

			resetVol();
			seedFile("src/a.spec.ts");
			const { createSetupResolver } = await import("../config/setup-resolver");
			vi.mocked(createSetupResolver).mockReturnValue((input) => `r:${input}`);
			const capture: BackendCapture = { closeCalls: 0, runCalls: 0 };
			await setupBackend(createFakeBackend(makeJestResult(), capture));

			await runSingleProject(makeOptions({ setupFilesAfterEnv: ["./post.ts"] }));

			expect(capture.runOptions?.jobs[0]?.config.setupFilesAfterEnv).toStrictEqual([
				"r:./post.ts",
			]);
		});
	});
});
