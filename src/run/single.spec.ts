import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import * as path from "node:path";
import process from "node:process";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import type { Backend, BackendOptions, BackendResult } from "../backends/interface.ts";
import type { CliOptions, ResolvedConfig } from "../config/schema.ts";
import { DEFAULT_CONFIG } from "../config/schema.ts";
import type { JestResult } from "../types/jest-result.ts";
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

vi.mock(import("../coverage/instrumenter"));
vi.mock(import("../utils/rojo-builder"));
vi.mock(import("../backends/auto"));
vi.mock(import("../config/setup-resolver"));

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
				makeOptions({ passWithNoTests: false, typecheck: true, typecheckOnly: true }),
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
				makeOptions({ passWithNoTests: true, typecheck: true, typecheckOnly: true }),
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
					typecheck: true,
					typecheckOnly: true,
				}),
			);

			expect(result.runtimeResult).toBeUndefined();
			expect(capture.runCalls).toBe(0);
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

			const result = await runSingleProject(
				makeOptions({ testMatch: ["**/*.spec.ts", "**/*.spec-d.ts"], typecheck: true }),
			);

			expect(result.runtimeResult?.exitCode).toBe(0);
			expect(result.typecheckResult).toBeDefined();
			expect(capture.runCalls).toBe(1);
		});
	});

	describe("when collectCoverage is enabled", () => {
		it("should run prepareCoverage, time it, and override placeFile", async () => {
			expect.assertions(2);

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

			const { instrumentRoot } = await import("../coverage/instrumenter");
			vi.mocked(instrumentRoot).mockReturnValue({});
			const { buildWithRojo } = await import("../utils/rojo-builder");
			vi.mocked(buildWithRojo).mockReturnValue(undefined);

			const capture: BackendCapture = { closeCalls: 0, runCalls: 0 };
			await setupBackend(createFakeBackend(makeJestResult(), capture));

			const result = await runSingleProject(makeOptions({ collectCoverage: true }));

			expect(result.preCoverageMs).toBeGreaterThanOrEqual(0);
			expect(capture.runOptions?.jobs[0]?.config.placeFile).toContain("game.rbxl");
		});

		it("should skip prepareCoverage when typecheckOnly is set", async () => {
			expect.assertions(2);

			resetVol();
			seedFile("src/a.spec-d.ts", "test('typed', () => {});");

			const { instrumentRoot } = await import("../coverage/instrumenter");
			const instrumentMock = vi.mocked(instrumentRoot).mockReturnValue({});
			await setupBackend();

			const result = await runSingleProject(
				makeOptions({
					collectCoverage: true,
					testMatch: ["**/*.spec-d.ts"],
					typecheck: true,
					typecheckOnly: true,
				}),
			);

			expect(result.preCoverageMs).toBe(0);
			expect(instrumentMock).not.toHaveBeenCalled();
		});

		it("should skip prepareCoverage when there are no runtime files", async () => {
			expect.assertions(1);

			resetVol();
			seedFile("src/a.spec-d.ts", "test('typed', () => {});");

			const { instrumentRoot } = await import("../coverage/instrumenter");
			const instrumentMock = vi.mocked(instrumentRoot).mockReturnValue({});
			await setupBackend();

			await runSingleProject(
				makeOptions({
					collectCoverage: true,
					testMatch: ["**/*.spec-d.ts"],
					typecheck: true,
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
