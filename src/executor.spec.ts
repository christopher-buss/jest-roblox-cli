import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import type {
	Backend,
	BackendOptions,
	BackendResult,
	ProjectBackendResult,
} from "./backends/interface.ts";
import type { ResolvedConfig } from "./config/schema.ts";
import { DEFAULT_CONFIG } from "./config/schema.ts";
import type { RawCoverageData } from "./coverage/types.ts";
import {
	buildProjectJob,
	execute,
	executeBackend,
	type ExecuteOptions,
	isLuauProject,
	loadCoverageManifest,
	processProjectResult,
	readTsconfigMapping,
	resolveAllTsconfigMappings,
	resolveTsconfigDirectories,
} from "./executor.ts";
import { parseJestOutput } from "./reporter/parser.ts";
import type { JestResult } from "./types/jest-result.ts";

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});
// get-tsconfig uses its own node:fs binding that vitest can't intercept (ESM).
// Re-implement getTsconfig to read from our mocked fs.
vi.mock(import("get-tsconfig"), async (importOriginal) => {
	const actual = await importOriginal();
	const nodeFs = await import("node:fs");
	const nodePath = await import("node:path");
	return fromAny({
		...actual,
		getTsconfig: (searchPath: string, configName = "tsconfig.json") => {
			const resolved = nodePath.resolve(searchPath);
			const filePath = nodePath.join(resolved, configName);
			try {
				const content = nodeFs.readFileSync(filePath, "utf-8");
				return { config: JSON.parse(content) as unknown, path: filePath };
			} catch {
				return null;
			}
		},
	});
});

function seedCwd(): void {
	vol.mkdirSync(process.cwd(), { recursive: true });
}

seedCwd();

function createFailingResult(): JestResult {
	return {
		numFailedTests: 1,
		numPassedTests: 1,
		numPendingTests: 0,
		numTotalTests: 2,
		startTime: Date.now(),
		success: false,
		testResults: [
			{
				numFailingTests: 1,
				numPassingTests: 1,
				numPendingTests: 0,
				testFilePath: "src/test.spec.ts",
				testResults: [
					{
						ancestorTitles: ["Test"],
						duration: 10,
						failureMessages: [],
						fullName: "Test passes",
						status: "passed",
						title: "passes",
					},
					{
						ancestorTitles: ["Test"],
						duration: 5,
						failureMessages: ["Expected true, got false"],
						fullName: "Test fails",
						status: "failed",
						title: "fails",
					},
				],
			},
		],
	};
}

const DEFAULT_TIMING: BackendResult["timing"] = {
	executionMs: 100,
	uploadCached: false,
	uploadMs: 50,
};

function singleEntryResult(
	entry: Partial<ProjectBackendResult> & Pick<ProjectBackendResult, "result">,
	timing: BackendResult["timing"] = DEFAULT_TIMING,
): BackendResult {
	return {
		results: [{ displayName: "", elapsedMs: 0, ...entry }],
		timing,
	};
}

function createMockBackend(result: JestResult, gameOutput?: string): Backend {
	return {
		kind: "studio",
		runTests: async (): Promise<BackendResult> => singleEntryResult({ gameOutput, result }),
	};
}

function createMockBackendWithCoverage(result: JestResult, coverageData: RawCoverageData): Backend {
	return {
		kind: "studio",
		runTests: async (): Promise<BackendResult> => singleEntryResult({ coverageData, result }),
	};
}

function createMixedResult(): JestResult {
	return {
		numFailedTests: 1,
		numPassedTests: 3,
		numPendingTests: 0,
		numTotalTests: 4,
		startTime: Date.now(),
		success: false,
		testResults: [
			{
				numFailingTests: 0,
				numPassingTests: 2,
				numPendingTests: 0,
				testFilePath: "src/utils.spec.ts",
				testResults: [
					{
						ancestorTitles: ["Utils"],
						duration: 10,
						failureMessages: [],
						fullName: "Utils adds",
						status: "passed",
						title: "adds",
					},
					{
						ancestorTitles: ["Utils"],
						duration: 5,
						failureMessages: [],
						fullName: "Utils subs",
						status: "passed",
						title: "subs",
					},
				],
			},
			{
				numFailingTests: 1,
				numPassingTests: 1,
				numPendingTests: 0,
				testFilePath: "src/test.spec.ts",
				testResults: [
					{
						ancestorTitles: ["Test"],
						duration: 10,
						failureMessages: [],
						fullName: "Test passes",
						status: "passed",
						title: "passes",
					},
					{
						ancestorTitles: ["Test"],
						duration: 5,
						failureMessages: ["Expected true, got false"],
						fullName: "Test fails",
						status: "failed",
						title: "fails",
					},
				],
			},
		],
	};
}

function createPassingResult(): JestResult {
	return {
		numFailedTests: 0,
		numPassedTests: 2,
		numPendingTests: 0,
		numTotalTests: 2,
		startTime: Date.now(),
		success: true,
		testResults: [
			{
				numFailingTests: 0,
				numPassingTests: 2,
				numPendingTests: 0,
				testFilePath: "src/test.spec.ts",
				testResults: [
					{
						ancestorTitles: ["Test"],
						duration: 10,
						failureMessages: [],
						fullName: "Test passes",
						status: "passed",
						title: "passes",
					},
					{
						ancestorTitles: ["Test"],
						duration: 5,
						failureMessages: [],
						fullName: "Test also passes",
						status: "passed",
						title: "also passes",
					},
				],
			},
		],
	};
}

let temporaryDirectoryCounter = 0;

function createTemporaryDirectory(prefix: string): string {
	const directory = path.resolve(`/tmp/${prefix}${temporaryDirectoryCounter}`);
	temporaryDirectoryCounter += 1;
	vol.mkdirSync(directory, { recursive: true });
	onTestFinished(() => {
		vol.reset();
		seedCwd();
	});
	return directory;
}

describe(execute, () => {
	it("should return exit code 0 when all tests pass", async () => {
		expect.assertions(2);

		const backend = createMockBackend(createPassingResult());
		const options: ExecuteOptions = {
			backend,
			config: DEFAULT_CONFIG,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await execute(options);

		expect(result.exitCode).toBe(0);
		expect(result.result.success).toBeTrue();
	});

	it("should handle test results without duration", async () => {
		expect.assertions(1);

		const resultWithoutDuration: JestResult = {
			numFailedTests: 0,
			numPassedTests: 1,
			numPendingTests: 0,
			numTotalTests: 1,
			startTime: Date.now(),
			success: true,
			testResults: [
				{
					numFailingTests: 0,
					numPassingTests: 1,
					numPendingTests: 0,
					testFilePath: "src/test.spec.ts",
					testResults: [
						{
							ancestorTitles: ["Test"],
							failureMessages: [],
							fullName: "Test passes",
							status: "passed",
							title: "passes",
						},
					],
				},
			],
		};

		const backend = createMockBackend(resultWithoutDuration);
		const options: ExecuteOptions = {
			backend,
			config: DEFAULT_CONFIG,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await execute(options);

		expect(result.exitCode).toBe(0);
	});

	it("should return exit code 1 when tests fail", async () => {
		expect.assertions(2);

		const backend = createMockBackend(createFailingResult());
		const options: ExecuteOptions = {
			backend,
			config: DEFAULT_CONFIG,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await execute(options);

		expect(result.exitCode).toBe(1);
		expect(result.result.success).toBeFalse();
	});

	it("should pass test name pattern to backend", async () => {
		expect.assertions(1);

		let capturedOptions: BackendOptions | undefined;
		const backend: Backend = {
			kind: "studio",
			runTests: async (options_): Promise<BackendResult> => {
				capturedOptions = options_;
				return singleEntryResult({ result: createPassingResult() });
			},
		};

		const config: ResolvedConfig = { ...DEFAULT_CONFIG, testNamePattern: "should pass" };
		const options: ExecuteOptions = {
			backend,
			config,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		await execute(options);

		expect(capturedOptions?.jobs[0]?.config.testNamePattern).toBe("should pass");
	});

	it("should format output as human-readable by default", async () => {
		expect.assertions(2);

		const backend = createMockBackend(createPassingResult());
		const options: ExecuteOptions = {
			backend,
			config: DEFAULT_CONFIG,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await execute(options);

		expect(result.output).toContain("✓");
		expect(result.output).toContain("2 passed");
	});

	it("should format output as JSON when json formatter is enabled", async () => {
		expect.assertions(2);

		const backend = createMockBackend(createPassingResult());
		const config: ResolvedConfig = { ...DEFAULT_CONFIG, formatters: ["json"] };
		const options: ExecuteOptions = {
			backend,
			config,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await execute(options);

		const parsed = parseJestOutput(result.output);

		expect(parsed.result.success).toBeTrue();
		expect(parsed.result.numTotalTests).toBe(2);
	});

	it("should pass through gameOutput from backend", async () => {
		expect.assertions(1);

		const rawGameOutput = '[{"message":"hello","messageType":0,"timestamp":1000}]';
		const backend = createMockBackend(createPassingResult(), rawGameOutput);
		const options: ExecuteOptions = {
			backend,
			config: DEFAULT_CONFIG,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await execute(options);

		expect(result.gameOutput).toBe(rawGameOutput);
	});

	it("should fall through to default formatter when agent and verbose are both set", async () => {
		expect.assertions(2);

		const backend = createMockBackend(createMixedResult());
		const config: ResolvedConfig = {
			...DEFAULT_CONFIG,
			formatters: ["agent"],
			verbose: true,
		};
		const options: ExecuteOptions = {
			backend,
			config,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await execute(options);

		// verbose cancels agent — uses default formatter which includes RUN
		// header
		expect(result.output).toContain("RUN");
		expect(result.output).toContain("Test Files");
	});

	it("should resolve outputFile and gameOutput paths when configured", async () => {
		expect.assertions(2);

		const backend = createMockBackend(createPassingResult());
		const config: ResolvedConfig = {
			...DEFAULT_CONFIG,
			gameOutput: "./game-output.json",
			outputFile: "./results.json",
		};
		const options: ExecuteOptions = {
			backend,
			config,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await execute(options);

		expect(result.exitCode).toBe(0);
		expect(result.output).not.toBeEmpty();
	});

	it("should return empty output when silent", async () => {
		expect.assertions(1);

		const backend = createMockBackend(createPassingResult());
		const config: ResolvedConfig = { ...DEFAULT_CONFIG, silent: true };
		const options: ExecuteOptions = {
			backend,
			config,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await execute(options);

		expect(result.output).toBe("");
	});

	it("should return timing in result", async () => {
		expect.assertions(4);

		const backend = createMockBackend(createPassingResult());
		const options: ExecuteOptions = {
			backend,
			config: DEFAULT_CONFIG,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await execute(options);

		expect(result.timing.executionMs).toBe(100);
		expect(result.timing.uploadMs).toBe(50);
		expect(result.timing.totalMs).toBeGreaterThanOrEqual(0);
		expect(result.timing.testsMs).toBeGreaterThanOrEqual(0);
	});

	it("should return empty output when deferFormatting is true", async () => {
		expect.assertions(2);

		const backend = createMockBackend(createPassingResult());
		const options: ExecuteOptions = {
			backend,
			config: DEFAULT_CONFIG,
			deferFormatting: true,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await execute(options);

		expect(result.output).toBe("");
		expect(result.timing.totalMs).toBeGreaterThanOrEqual(0);
	});

	it("should return coverageData when backend provides it", async () => {
		expect.assertions(1);

		const coverageData: RawCoverageData = {
			"shared/player.luau": { s: { "0": 3, "1": 0, "2": 1 } },
		};

		const backend = createMockBackendWithCoverage(createPassingResult(), coverageData);
		const config: ResolvedConfig = {
			...DEFAULT_CONFIG,
			collectCoverage: true,
		};
		const options: ExecuteOptions = {
			backend,
			config,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await execute(options);

		expect(result.coverageData).toBe(coverageData);
	});

	it("should pass through coverageData regardless of collectCoverage", async () => {
		expect.assertions(1);

		const coverageData: RawCoverageData = {
			"shared/player.luau": { s: { "0": 3, "1": 0, "2": 1 } },
		};

		const backend = createMockBackendWithCoverage(createPassingResult(), coverageData);
		const config: ResolvedConfig = { ...DEFAULT_CONFIG, collectCoverage: false };
		const options: ExecuteOptions = {
			backend,
			config,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await execute(options);

		// coverageData is still returned (backend always provides it), but
		// coverage processing is now handled by cli.ts
		expect(result.coverageData).toBe(coverageData);
	});

	it("should not factor coverage into exit code", async () => {
		expect.assertions(1);

		const coverageData: RawCoverageData = {
			"shared/player.luau": { s: { "0": 3, "1": 0, "2": 1 } },
		};

		const backend = createMockBackendWithCoverage(createPassingResult(), coverageData);
		const config: ResolvedConfig = {
			...DEFAULT_CONFIG,
			collectCoverage: true,
			coverageThreshold: { statements: 80 },
		};
		const options: ExecuteOptions = {
			backend,
			config,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await execute(options);

		// exit code is based only on test success, not coverage thresholds
		expect(result.exitCode).toBe(0);
	});

	it("should skip source mapper when sourceMap is false", async () => {
		expect.assertions(1);

		const backend = createMockBackend(createPassingResult());
		const config: ResolvedConfig = { ...DEFAULT_CONFIG, sourceMap: false };
		const options: ExecuteOptions = {
			backend,
			config,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await execute(options);

		expect(result.exitCode).toBe(0);
	});

	it("should use agent formatter when agent is in formatters", async () => {
		expect.assertions(2);

		const backend = createMockBackend(createFailingResult());
		const config: ResolvedConfig = { ...DEFAULT_CONFIG, formatters: ["agent"] };
		const options: ExecuteOptions = {
			backend,
			config,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await execute(options);

		// Agent format uses PASS/FAIL prefix per file, no verbose headers
		expect(result.output).toContain("FAIL");
		expect(result.output).not.toContain("RUN");
	});

	it("should respect maxFailures from agent formatter options tuple", async () => {
		expect.assertions(1);

		const backend = createMockBackend(createFailingResult());
		const config: ResolvedConfig = {
			...DEFAULT_CONFIG,
			formatters: [["agent", { maxFailures: 1 }]],
		};
		const options: ExecuteOptions = {
			backend,
			config,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await execute(options);

		expect(result.output).toContain("FAIL");
	});

	it("should handle backend providing luau timing", async () => {
		expect.assertions(1);

		const backend: Backend = {
			kind: "studio",
			runTests: async (): Promise<BackendResult> => {
				return singleEntryResult(
					{
						luauTiming: { requireJest: 1.5 },
						result: createPassingResult(),
					},
					{ executionMs: 100, uploadCached: false, uploadMs: 50 },
				);
			},
		};

		const options: ExecuteOptions = {
			backend,
			config: DEFAULT_CONFIG,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		// Should not throw when luauTiming is present
		const result = await execute(options);

		expect(result.exitCode).toBe(0);
	});

	it("should resolve DataModel testFilePaths to filesystem paths", async () => {
		expect.assertions(2);

		const temporaryDirectory = createTemporaryDirectory("executor-test-");
		fs.writeFileSync(
			path.join(temporaryDirectory, "default.project.json"),
			JSON.stringify({
				name: "test-game",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$className: "ReplicatedStorage",
						Client: { $path: "src/client" },
					},
				},
			}),
		);

		const dataModelPath = "ReplicatedStorage/Client/lib/test.spec";
		const result: JestResult = {
			...createPassingResult(),
			testResults: [
				{
					numFailingTests: 0,
					numPassingTests: 1,
					numPendingTests: 0,
					testFilePath: dataModelPath,
					testResults: [
						{
							ancestorTitles: ["Test"],
							duration: 10,
							failureMessages: [],
							fullName: "Test passes",
							status: "passed",
							title: "passes",
						},
					],
				},
			],
		};

		const backend = createMockBackend(result);
		const config: ResolvedConfig = {
			...DEFAULT_CONFIG,
			rootDir: temporaryDirectory,
			sourceMap: true,
		};
		const options: ExecuteOptions = {
			backend,
			config,
			testFiles: ["src/client/lib/test.spec.luau"],
			version: "0.0.0-test",
		};

		const executeResult = await execute(options);

		expect(executeResult.output).not.toContain(dataModelPath);
		expect(executeResult.result.testResults[0]!.testFilePath).toContain(
			"src/client/lib/test.spec",
		);
	});

	it("should handle backend providing snapshot writes", async () => {
		expect.assertions(1);

		const backend: Backend = {
			kind: "studio",
			runTests: async (): Promise<BackendResult> => {
				return singleEntryResult(
					{
						result: createPassingResult(),
						snapshotWrites: {
							"ReplicatedStorage/shared/__snapshots__/test.snap.luau":
								"snapshot content",
						},
					},
					{ executionMs: 100, uploadCached: false, uploadMs: 50 },
				);
			},
		};

		const options: ExecuteOptions = {
			backend,
			config: DEFAULT_CONFIG,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		// Should not throw even when rojo project isn't found
		const result = await execute(options);

		expect(result.exitCode).toBe(0);
	});

	it("should write multiple snapshots and use plural message", async () => {
		expect.assertions(3);

		const temporaryDirectory = createTemporaryDirectory("exec-snap-");

		const rojoProject = {
			name: "test",
			tree: { ReplicatedStorage: { $path: "src/shared" } },
		};
		fs.writeFileSync(
			path.join(temporaryDirectory, "default.project.json"),
			JSON.stringify(rojoProject),
		);

		const backend: Backend = {
			kind: "studio",
			runTests: async (): Promise<BackendResult> => {
				return singleEntryResult(
					{
						result: createPassingResult(),
						snapshotWrites: {
							"ReplicatedStorage/__snapshots__/a.snap.luau": "snap a",
							"ReplicatedStorage/__snapshots__/b.snap.luau": "snap b",
						},
					},
					{ executionMs: 100, uploadCached: false, uploadMs: 50 },
				);
			},
		};

		const config: ResolvedConfig = { ...DEFAULT_CONFIG, rootDir: temporaryDirectory };
		const options: ExecuteOptions = {
			backend,
			config,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await execute(options);

		expect(result.exitCode).toBe(0);

		const snapshotA = path.join(temporaryDirectory, "src/shared/__snapshots__/a.snap.luau");
		const snapshotB = path.join(temporaryDirectory, "src/shared/__snapshots__/b.snap.luau");

		expect(fs.existsSync(snapshotA)).toBeTrue();
		expect(fs.existsSync(snapshotB)).toBeTrue();
	});

	it("should find non-default rojo project file", async () => {
		expect.assertions(1);

		const temporaryDirectory = createTemporaryDirectory("exec-snap-");

		const rojoProject = {
			name: "test",
			tree: { ReplicatedStorage: { $path: "out/shared" } },
		};
		fs.writeFileSync(
			path.join(temporaryDirectory, "custom.project.json"),
			JSON.stringify(rojoProject),
		);

		const backend: Backend = {
			kind: "studio",
			runTests: async (): Promise<BackendResult> => {
				return singleEntryResult(
					{
						result: createPassingResult(),
						snapshotWrites: {
							"ReplicatedStorage/__snapshots__/test.snap.luau": "snap",
						},
					},
					{ executionMs: 100, uploadCached: false, uploadMs: 50 },
				);
			},
		};

		const config: ResolvedConfig = { ...DEFAULT_CONFIG, rootDir: temporaryDirectory };
		const options: ExecuteOptions = {
			backend,
			config,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await execute(options);

		expect(result.exitCode).toBe(0);
	});

	it("should warn when snapshot path cannot be resolved", async () => {
		expect.assertions(1);

		const temporaryDirectory = createTemporaryDirectory("exec-snap-");

		const rojoProject = {
			name: "test",
			tree: { ReplicatedStorage: { $path: "out/shared" } },
		};
		fs.writeFileSync(
			path.join(temporaryDirectory, "default.project.json"),
			JSON.stringify(rojoProject),
		);

		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		const backend: Backend = {
			kind: "studio",
			runTests: async (): Promise<BackendResult> => {
				return singleEntryResult(
					{
						result: createPassingResult(),
						snapshotWrites: {
							"UnknownService/__snapshots__/test.snap.luau": "snap content",
						},
					},
					{ executionMs: 100, uploadCached: false, uploadMs: 50 },
				);
			},
		};

		const config: ResolvedConfig = { ...DEFAULT_CONFIG, rootDir: temporaryDirectory };
		const options: ExecuteOptions = {
			backend,
			config,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		await execute(options);

		expect(stderrSpy).toHaveBeenCalledWith(
			expect.stringContaining("Cannot resolve snapshot path"),
		);

		stderrSpy.mockRestore();
	});

	it("should warn when rojo project has invalid schema for snapshots", async () => {
		expect.assertions(1);

		const temporaryDirectory = createTemporaryDirectory("exec-snap-");

		fs.writeFileSync(
			path.join(temporaryDirectory, "default.project.json"),
			JSON.stringify({ invalid: "schema" }),
		);

		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		const backend: Backend = {
			kind: "studio",
			runTests: async (): Promise<BackendResult> => {
				return singleEntryResult(
					{
						result: createPassingResult(),
						snapshotWrites: {
							"ReplicatedStorage/__snapshots__/test.snap.luau": "snap",
						},
					},
					{ executionMs: 100, uploadCached: false, uploadMs: 50 },
				);
			},
		};

		const config: ResolvedConfig = { ...DEFAULT_CONFIG, rootDir: temporaryDirectory };
		const options: ExecuteOptions = {
			backend,
			config,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		await execute(options);

		expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("invalid rojo project"));

		stderrSpy.mockRestore();
	});

	it("should warn with banner when rojo project JSON is invalid", async () => {
		expect.assertions(3);

		const temporaryDirectory = createTemporaryDirectory("exec-snap-");

		// Valid file path but invalid JSON triggers SyntaxError catch branch
		fs.writeFileSync(
			path.join(temporaryDirectory, "default.project.json"),
			"not valid json {{{",
		);

		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		const backend: Backend = {
			kind: "studio",
			runTests: async (): Promise<BackendResult> => {
				return singleEntryResult(
					{
						result: createPassingResult(),
						snapshotWrites: {
							"ReplicatedStorage/__snapshots__/test.snap.luau": "snap",
						},
					},
					{ executionMs: 100, uploadCached: false, uploadMs: 50 },
				);
			},
		};

		const config: ResolvedConfig = { ...DEFAULT_CONFIG, rootDir: temporaryDirectory };
		const options: ExecuteOptions = {
			backend,
			config,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		await execute(options);

		const output = stderrSpy.mock.calls.map(([message]) => String(message)).join("");

		expect(output).toContain("Snapshot Warning");
		expect(output).toContain("Failed to parse rojo project");
		expect(output).toContain("default.project.json");

		stderrSpy.mockRestore();
	});

	it("should warn generically when snapshot write throws non-SyntaxError", async () => {
		expect.assertions(1);

		const temporaryDirectory = createTemporaryDirectory("exec-snap-");

		const rojoProject = {
			name: "test",
			tree: { ReplicatedStorage: { $path: "out/shared" } },
		};
		fs.writeFileSync(
			path.join(temporaryDirectory, "default.project.json"),
			JSON.stringify(rojoProject),
		);

		// Create a file where mkdirSync expects a directory, causing a
		// non-SyntaxError when writing the snapshot
		const snapshotsPath = path.join(temporaryDirectory, "out/shared/__snapshots__");
		fs.mkdirSync(path.join(temporaryDirectory, "out/shared"), { recursive: true });
		fs.writeFileSync(snapshotsPath, "blocker");

		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		const backend: Backend = {
			kind: "studio",
			runTests: async (): Promise<BackendResult> => {
				return singleEntryResult(
					{
						result: createPassingResult(),
						snapshotWrites: {
							"ReplicatedStorage/__snapshots__/test.snap.luau": "snap",
						},
					},
					{ executionMs: 100, uploadCached: false, uploadMs: 50 },
				);
			},
		};

		const config: ResolvedConfig = { ...DEFAULT_CONFIG, rootDir: temporaryDirectory };
		const options: ExecuteOptions = {
			backend,
			config,
			testFiles: [],
			version: "0.0.0-test",
		};

		await execute(options);

		const output = stderrSpy.mock.calls.map(([message]) => String(message)).join("");
		stderrSpy.mockRestore();

		expect(output).toContain("Failed to write snapshot files");
	});

	it("should resolve tsconfig outDir for snapshot source rewriting", async () => {
		expect.assertions(1);

		const temporaryDirectory = createTemporaryDirectory("exec-snap-tsconfig-");

		fs.writeFileSync(
			path.join(temporaryDirectory, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: { outDir: "./out-tsc/test", rootDir: "./src" },
			}),
		);
		fs.writeFileSync(
			path.join(temporaryDirectory, "default.project.json"),
			JSON.stringify({
				name: "test",
				tree: { ReplicatedStorage: { $path: "out-tsc/test" } },
			}),
		);

		const backend: Backend = {
			kind: "studio",
			runTests: async (): Promise<BackendResult> => {
				return singleEntryResult(
					{
						result: createPassingResult(),
						snapshotWrites: {
							"ReplicatedStorage/__snapshots__/test.spec.snap.luau": "-- snapshot",
						},
					},
					{ executionMs: 100, uploadCached: false, uploadMs: 50 },
				);
			},
		};

		const config: ResolvedConfig = {
			...DEFAULT_CONFIG,
			rootDir: temporaryDirectory,
			silent: true,
		};

		await execute({ backend, config, testFiles: [], version: "0.0.0-test" });

		const sourceSnapshot = path.join(
			temporaryDirectory,
			"src/__snapshots__/test.spec.snap.luau",
		);

		expect(fs.existsSync(sourceSnapshot)).toBeTrue();
	});

	it("should dual-write snapshots to both source and out directories", async () => {
		expect.assertions(2);

		const temporaryDirectory = createTemporaryDirectory("exec-snap-dual-");

		fs.writeFileSync(
			path.join(temporaryDirectory, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: { outDir: "./out-tsc/test", rootDir: "./src" },
			}),
		);
		fs.writeFileSync(
			path.join(temporaryDirectory, "default.project.json"),
			JSON.stringify({
				name: "test",
				tree: { ReplicatedStorage: { $path: "out-tsc/test" } },
			}),
		);

		const backend: Backend = {
			kind: "studio",
			runTests: async (): Promise<BackendResult> => {
				return singleEntryResult(
					{
						result: createPassingResult(),
						snapshotWrites: {
							"ReplicatedStorage/__snapshots__/test.spec.snap.luau": "-- snapshot",
						},
					},
					{ executionMs: 100, uploadCached: false, uploadMs: 50 },
				);
			},
		};

		const config: ResolvedConfig = {
			...DEFAULT_CONFIG,
			rootDir: temporaryDirectory,
			silent: true,
		};

		await execute({ backend, config, testFiles: [], version: "0.0.0-test" });

		const sourceSnapshot = path.join(
			temporaryDirectory,
			"src/__snapshots__/test.spec.snap.luau",
		);
		const outSnapshot = path.join(
			temporaryDirectory,
			"out-tsc/test/__snapshots__/test.spec.snap.luau",
		);

		expect(fs.existsSync(sourceSnapshot)).toBeTrue();
		expect(fs.existsSync(outSnapshot)).toBeTrue();
	});

	it("should fall back to rojo-resolved path when no tsconfig exists", async () => {
		expect.assertions(2);

		const temporaryDirectory = createTemporaryDirectory("exec-snap-no-tsconfig-");

		fs.writeFileSync(
			path.join(temporaryDirectory, "default.project.json"),
			JSON.stringify({
				name: "test",
				tree: { ReplicatedStorage: { $path: "out-tsc/test" } },
			}),
		);

		const backend: Backend = {
			kind: "studio",
			runTests: async (): Promise<BackendResult> => {
				return singleEntryResult(
					{
						result: createPassingResult(),
						snapshotWrites: {
							"ReplicatedStorage/__snapshots__/test.spec.snap.luau": "-- snapshot",
						},
					},
					{ executionMs: 100, uploadCached: false, uploadMs: 50 },
				);
			},
		};

		const config: ResolvedConfig = {
			...DEFAULT_CONFIG,
			rootDir: temporaryDirectory,
			silent: true,
		};

		await execute({ backend, config, testFiles: [], version: "0.0.0-test" });

		// No tsconfig → no outDir/rootDir rewriting → lands at rojo-resolved path
		const outSnapshot = path.join(
			temporaryDirectory,
			"out-tsc/test/__snapshots__/test.spec.snap.luau",
		);
		const sourceSnapshot = path.join(
			temporaryDirectory,
			"src/__snapshots__/test.spec.snap.luau",
		);

		expect(fs.existsSync(outSnapshot)).toBeTrue();
		expect(fs.existsSync(sourceSnapshot)).toBeFalse();
	});

	it("should build source mapper when rojo project exists", async () => {
		expect.assertions(1);

		const temporaryDirectory = createTemporaryDirectory("exec-sm-");

		const rojoProject = {
			name: "test",
			tree: { ReplicatedStorage: { $path: "out/shared" } },
		};
		fs.writeFileSync(
			path.join(temporaryDirectory, "default.project.json"),
			JSON.stringify(rojoProject),
		);

		const backend = createMockBackend(createFailingResult());
		const config: ResolvedConfig = {
			...DEFAULT_CONFIG,
			rootDir: temporaryDirectory,
			sourceMap: true,
		};
		const options: ExecuteOptions = {
			backend,
			config,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await execute(options);

		// Source mapper was built (failure messages won't contain rojo paths
		// though)
		expect(result.exitCode).toBe(1);
	});

	it("should resolve test file paths through nested rojo projects", async () => {
		expect.assertions(1);

		const temporaryDirectory = createTemporaryDirectory("exec-nested-rojo-");

		// Root project references a nested package via default.project.json
		const rootProject = {
			name: "test",
			tree: {
				ReplicatedStorage: {
					"uuid-generator": {
						$path: "packages/uuid-generator/default.project.json",
					},
				},
			},
		};
		fs.writeFileSync(
			path.join(temporaryDirectory, "default.project.json"),
			JSON.stringify(rootProject),
		);

		// Nested package project points to src/
		const nestedProject = {
			name: "uuid-generator",
			tree: { $path: "src" },
		};
		const nestedDirectory = path.join(temporaryDirectory, "packages/uuid-generator");
		fs.mkdirSync(nestedDirectory, { recursive: true });
		fs.writeFileSync(
			path.join(nestedDirectory, "default.project.json"),
			JSON.stringify(nestedProject),
		);

		// Backend returns DataModel path as Jest would
		const result = createPassingResult();
		result.testResults[0]!.testFilePath = "/ReplicatedStorage/uuid-generator/init.spec";
		const backend = createMockBackend(result);

		const config: ResolvedConfig = {
			...DEFAULT_CONFIG,
			rootDir: temporaryDirectory,
			sourceMap: true,
		};
		const options: ExecuteOptions = {
			backend,
			config,
			testFiles: ["packages/uuid-generator/src/init.spec.luau"],
			version: "0.0.0-test",
		};

		const executeResult = await execute(options);

		expect(executeResult.result.testResults[0]!.testFilePath).toBe(
			"packages/uuid-generator/src/init.spec.luau",
		);
	});

	it("should write snapshots through nested rojo projects", async () => {
		expect.assertions(1);

		const temporaryDirectory = createTemporaryDirectory("exec-nested-snap-");

		const rootProject = {
			name: "test",
			tree: {
				ReplicatedStorage: {
					"uuid-generator": {
						$path: "packages/uuid-generator/default.project.json",
					},
				},
			},
		};
		fs.writeFileSync(
			path.join(temporaryDirectory, "default.project.json"),
			JSON.stringify(rootProject),
		);

		const nestedProject = {
			name: "uuid-generator",
			tree: { $path: "src" },
		};
		const nestedDirectory = path.join(temporaryDirectory, "packages/uuid-generator");
		fs.mkdirSync(nestedDirectory, { recursive: true });
		fs.writeFileSync(
			path.join(nestedDirectory, "default.project.json"),
			JSON.stringify(nestedProject),
		);

		const backend: Backend = {
			kind: "studio",
			runTests: async (): Promise<BackendResult> => {
				return singleEntryResult(
					{
						result: createPassingResult(),
						snapshotWrites: {
							"ReplicatedStorage/uuid-generator/__snapshots__/init.spec.snap.luau":
								"-- snapshot",
						},
					},
					{ executionMs: 100, uploadCached: false, uploadMs: 50 },
				);
			},
		};

		const config: ResolvedConfig = { ...DEFAULT_CONFIG, rootDir: temporaryDirectory };
		await execute({ backend, config, testFiles: [], version: "0.0.0-test" });

		const snapshotPath = path.join(
			temporaryDirectory,
			"packages/uuid-generator/src/__snapshots__/init.spec.snap.luau",
		);

		expect(fs.existsSync(snapshotPath)).toBeTrue();
	});

	it("should return undefined source mapper when rojo project has invalid schema", async () => {
		expect.assertions(1);

		const temporaryDirectory = createTemporaryDirectory("exec-sm-");

		fs.writeFileSync(
			path.join(temporaryDirectory, "default.project.json"),
			JSON.stringify({ invalid: "schema" }),
		);

		const backend = createMockBackend(createPassingResult());
		const config: ResolvedConfig = {
			...DEFAULT_CONFIG,
			rootDir: temporaryDirectory,
			sourceMap: true,
		};
		const options: ExecuteOptions = {
			backend,
			config,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await execute(options);

		expect(result.exitCode).toBe(0);
	});
});

describe(readTsconfigMapping, () => {
	it("should return mapping from tsconfig with compilerOptions", () => {
		expect.assertions(1);

		const temporaryDirectory = createTemporaryDirectory("read-tsconfig-");
		const tsconfigPath = path.join(temporaryDirectory, "tsconfig.json");
		fs.writeFileSync(
			tsconfigPath,
			JSON.stringify({ compilerOptions: { outDir: "out", rootDir: "src" } }),
		);

		const result = readTsconfigMapping(tsconfigPath);

		expect(result).toStrictEqual({ outDir: "out", rootDir: "src" });
	});

	it("should return undefined when compilerOptions is missing", () => {
		expect.assertions(1);

		const temporaryDirectory = createTemporaryDirectory("read-tsconfig-no-opts-");
		const tsconfigPath = path.join(temporaryDirectory, "tsconfig.json");
		fs.writeFileSync(tsconfigPath, JSON.stringify({ include: ["src/**/*"] }));

		const result = readTsconfigMapping(tsconfigPath);

		expect(result).toBeUndefined();
	});

	it("should return undefined when file does not exist", () => {
		expect.assertions(1);

		const result = readTsconfigMapping("/nonexistent/tsconfig.json");

		expect(result).toBeUndefined();
	});

	it("should handle rootDirs with no common prefix", () => {
		expect.assertions(1);

		const temporaryDirectory = createTemporaryDirectory("read-tsconfig-no-prefix-");
		const tsconfigPath = path.join(temporaryDirectory, "tsconfig.json");
		fs.writeFileSync(
			tsconfigPath,
			JSON.stringify({
				compilerOptions: { outDir: "out-test", rootDirs: ["src", "test"] },
			}),
		);

		const result = readTsconfigMapping(tsconfigPath);

		expect(result).toStrictEqual({ outDir: "out-test", rootDir: "." });
	});

	it("should handle rootDirs with common ancestor", () => {
		expect.assertions(1);

		const temporaryDirectory = createTemporaryDirectory("read-tsconfig-ancestor-");
		const tsconfigPath = path.join(temporaryDirectory, "tsconfig.json");
		fs.writeFileSync(
			tsconfigPath,
			JSON.stringify({
				compilerOptions: {
					outDir: "out",
					rootDirs: ["packages/core/src", "packages/core/test"],
				},
			}),
		);

		const result = readTsconfigMapping(tsconfigPath);

		expect(result).toStrictEqual({ outDir: "out", rootDir: "packages/core" });
	});

	it("should default outDir to 'out' and rootDir to 'src' when omitted", () => {
		expect.assertions(1);

		const temporaryDirectory = createTemporaryDirectory("read-tsconfig-defaults-");
		const tsconfigPath = path.join(temporaryDirectory, "tsconfig.json");
		fs.writeFileSync(tsconfigPath, JSON.stringify({ compilerOptions: { strict: true } }));

		const result = readTsconfigMapping(tsconfigPath);

		expect(result).toStrictEqual({ outDir: "out", rootDir: "src" });
	});

	it("should return empty when rootDir is null", () => {
		expect.assertions(1);

		const temporaryDirectory = createTemporaryDirectory("read-tsconfig-null-");
		const tsconfigPath = path.join(temporaryDirectory, "tsconfig.json");
		fs.writeFileSync(
			tsconfigPath,
			JSON.stringify({ compilerOptions: { outDir: "out", rootDir: null } }),
		);

		const result = readTsconfigMapping(tsconfigPath);

		expect(result).toBeUndefined();
	});
});

describe(resolveAllTsconfigMappings, () => {
	it("should return mappings from multiple tsconfig*.json files", () => {
		expect.assertions(2);

		const temporaryDirectory = createTemporaryDirectory("tsconfig-multi-");
		fs.writeFileSync(
			path.join(temporaryDirectory, "tsconfig.lib.json"),
			JSON.stringify({ compilerOptions: { outDir: "out", rootDir: "src" } }),
		);
		fs.writeFileSync(
			path.join(temporaryDirectory, "tsconfig.spec.json"),
			JSON.stringify({ compilerOptions: { outDir: "out-test", rootDir: "src" } }),
		);

		const result = resolveAllTsconfigMappings(temporaryDirectory);

		expect(result).toHaveLength(2);
		expect(result).toContainEqual({ outDir: "out-test", rootDir: "src" });
	});

	it("should return single mapping when only tsconfig.json exists", () => {
		expect.assertions(1);

		const temporaryDirectory = createTemporaryDirectory("tsconfig-single-");
		fs.writeFileSync(
			path.join(temporaryDirectory, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { outDir: "out", rootDir: "src" } }),
		);

		const result = resolveAllTsconfigMappings(temporaryDirectory);

		expect(result).toStrictEqual([{ outDir: "out", rootDir: "src" }]);
	});

	it("should return empty array when no tsconfigs exist", () => {
		expect.assertions(1);

		const temporaryDirectory = createTemporaryDirectory("tsconfig-none-");

		const result = resolveAllTsconfigMappings(temporaryDirectory);

		expect(result).toBeEmpty();
	});

	it("should skip tsconfigs without compilerOptions", () => {
		expect.assertions(1);

		const temporaryDirectory = createTemporaryDirectory("tsconfig-no-opts-");
		fs.writeFileSync(
			path.join(temporaryDirectory, "tsconfig.json"),
			JSON.stringify({ include: ["src/**/*"] }),
		);

		const result = resolveAllTsconfigMappings(temporaryDirectory);

		expect(result).toBeEmpty();
	});

	it("should return empty array when directory does not exist", () => {
		expect.assertions(1);

		const result = resolveAllTsconfigMappings("/nonexistent/path/xyz");

		expect(result).toBeEmpty();
	});

	it("should deduplicate identical mappings across tsconfig files", () => {
		expect.assertions(1);

		const temporaryDirectory = createTemporaryDirectory("tsconfig-dup-");
		fs.writeFileSync(
			path.join(temporaryDirectory, "tsconfig.lib.json"),
			JSON.stringify({ compilerOptions: { outDir: "out", rootDir: "src" } }),
		);
		fs.writeFileSync(
			path.join(temporaryDirectory, "tsconfig.spec.json"),
			JSON.stringify({ compilerOptions: { outDir: "out", rootDir: "src" } }),
		);

		const result = resolveAllTsconfigMappings(temporaryDirectory);

		expect(result).toStrictEqual([{ outDir: "out", rootDir: "src" }]);
	});

	it("should skip malformed tsconfig JSON files", () => {
		expect.assertions(1);

		const temporaryDirectory = createTemporaryDirectory("tsconfig-bad-");
		fs.writeFileSync(path.join(temporaryDirectory, "tsconfig.json"), "not json {{{");

		const result = resolveAllTsconfigMappings(temporaryDirectory);

		expect(result).toBeEmpty();
	});
});

describe(resolveTsconfigDirectories, () => {
	it("should return undefined outDir/rootDir when no tsconfig exists", () => {
		expect.assertions(2);

		// Use a directory that has no tsconfig.json
		const result = resolveTsconfigDirectories("/nonexistent/project/dir");

		expect(result.outDir).toBeUndefined();
		expect(result.rootDir).toBeUndefined();
	});

	it("should default outDir to 'out' and rootDir to 'src' when compilerOptions omits them", () => {
		expect.assertions(2);

		const temporaryDirectory = createTemporaryDirectory("tsconfig-test-");
		fs.writeFileSync(
			path.join(temporaryDirectory, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { strict: true } }),
		);

		const result = resolveTsconfigDirectories(temporaryDirectory);

		expect(result.outDir).toBe("out");
		expect(result.rootDir).toBe("src");
	});
});

describe(isLuauProject, () => {
	it("should return false when mappings exist", () => {
		expect.assertions(1);

		expect(isLuauProject(["x.spec.ts"], [{ outDir: "out/", rootDir: "src/" }])).toBeFalse();
	});

	it("should return true when no mappings and luau test files", () => {
		expect.assertions(1);

		expect(isLuauProject(["x.spec.luau"], [])).toBeTrue();
	});

	it("should return false when no mappings but ts test files", () => {
		expect.assertions(1);

		expect(isLuauProject(["x.spec.ts"], [])).toBeFalse();
	});

	it("should return false when no mappings but tsx test files", () => {
		expect.assertions(1);

		expect(isLuauProject(["x.spec.tsx"], [])).toBeFalse();
	});

	it("should return true when testFiles is empty and no mappings", () => {
		expect.assertions(1);

		expect(isLuauProject([], [])).toBeTrue();
	});

	it("should return false when mixed ts and luau test files", () => {
		expect.assertions(1);

		expect(isLuauProject(["a.spec.luau", "b.spec.ts"], [])).toBeFalse();
	});
});

describe(buildProjectJob, () => {
	it("should resolve printBasicPrototype=true for Luau project", () => {
		expect.assertions(2);

		const job = buildProjectJob({
			config: DEFAULT_CONFIG,
			displayName: "luau-project",
			testFiles: ["src/a.spec.luau"],
		});

		expect(job.displayName).toBe("luau-project");
		expect(job.config.snapshotFormat?.printBasicPrototype).toBe(true);
	});

	it("should resolve printBasicPrototype=false for TS project", () => {
		expect.assertions(1);

		const job = buildProjectJob({
			config: DEFAULT_CONFIG,
			testFiles: ["src/a.spec.ts"],
		});

		expect(job.config.snapshotFormat?.printBasicPrototype).toBe(false);
	});

	it("should default displayName to empty string", () => {
		expect.assertions(1);

		const job = buildProjectJob({ config: DEFAULT_CONFIG, testFiles: [] });

		expect(job.displayName).toBe("");
	});

	it("should preserve displayColor", () => {
		expect.assertions(1);

		const job = buildProjectJob({
			config: DEFAULT_CONFIG,
			displayColor: "green",
			testFiles: [],
		});

		expect(job.displayColor).toBe("green");
	});

	it("should preserve existing snapshotFormat.printBasicPrototype when set", () => {
		expect.assertions(1);

		const config: ResolvedConfig = {
			...DEFAULT_CONFIG,
			snapshotFormat: { printBasicPrototype: false },
		};
		const job = buildProjectJob({ config, testFiles: ["src/a.spec.luau"] });

		expect(job.config.snapshotFormat?.printBasicPrototype).toBe(false);
	});
});

describe(executeBackend, () => {
	it("should call backend.runTests with jobs array and return BackendResult", async () => {
		expect.assertions(2);

		let captured: BackendOptions | undefined;
		const backend: Backend = {
			kind: "studio",
			runTests: async (options_) => {
				captured = options_;
				return {
					results: [{ displayName: "", elapsedMs: 42, result: createPassingResult() }],
					timing: { executionMs: 100, uploadCached: false, uploadMs: 0 },
				};
			},
		};

		const job = buildProjectJob({ config: DEFAULT_CONFIG, testFiles: [] });
		const result = await executeBackend(backend, [job]);

		expect(captured?.jobs).toHaveLength(1);
		expect(result.results[0]?.elapsedMs).toBe(42);
	});

	it("should forward parallel option to backend.runTests", async () => {
		expect.assertions(1);

		let captured: BackendOptions | undefined;
		const backend: Backend = {
			kind: "open-cloud",
			runTests: async (options_) => {
				captured = options_;
				return {
					results: [{ displayName: "", elapsedMs: 0, result: createPassingResult() }],
					timing: { executionMs: 0, uploadCached: false, uploadMs: 0 },
				};
			},
		};

		const job = buildProjectJob({ config: DEFAULT_CONFIG, testFiles: [] });
		await executeBackend(backend, [job], 3);

		expect(captured?.parallel).toBe(3);
	});

	it("should forward auto parallel value", async () => {
		expect.assertions(1);

		let captured: BackendOptions | undefined;
		const backend: Backend = {
			kind: "open-cloud",
			runTests: async (options_) => {
				captured = options_;
				return {
					results: [{ displayName: "", elapsedMs: 0, result: createPassingResult() }],
					timing: { executionMs: 0, uploadCached: false, uploadMs: 0 },
				};
			},
		};

		const job = buildProjectJob({ config: DEFAULT_CONFIG, testFiles: [] });
		await executeBackend(backend, [job], "auto");

		expect(captured?.parallel).toBe("auto");
	});
});

describe(processProjectResult, () => {
	it("should return ExecuteResult with backend timing and success exit code", () => {
		expect.assertions(3);

		const result = processProjectResult(
			{ displayName: "", elapsedMs: 0, result: createPassingResult() },
			{
				backendTiming: { executionMs: 200, uploadCached: true, uploadMs: 50 },
				config: DEFAULT_CONFIG,
				deferFormatting: true,
				startTime: Date.now(),
				version: "0.0.0-test",
			},
		);

		expect(result.exitCode).toBe(0);
		expect(result.timing.executionMs).toBe(200);
		expect(result.timing.uploadCached).toBeTrue();
	});

	it("should return exit code 1 when result fails", () => {
		expect.assertions(1);

		const result = processProjectResult(
			{ displayName: "", elapsedMs: 0, result: createFailingResult() },
			{
				backendTiming: { executionMs: 0 },
				config: DEFAULT_CONFIG,
				deferFormatting: true,
				startTime: Date.now(),
				version: "0.0.0-test",
			},
		);

		expect(result.exitCode).toBe(1);
	});
});

describe(loadCoverageManifest, () => {
	it("should return undefined when manifest file does not exist", () => {
		expect.assertions(1);

		const result = loadCoverageManifest("/nonexistent/dir");

		expect(result).toBeUndefined();
	});

	it("should warn and return undefined for malformed manifest JSON", () => {
		expect.assertions(2);

		const temporaryDirectory = createTemporaryDirectory("cov-test-");
		const coverageDirectory = path.join(temporaryDirectory, ".jest-roblox-coverage");
		fs.mkdirSync(coverageDirectory, { recursive: true });
		fs.writeFileSync(path.join(coverageDirectory, "manifest.json"), "not json");
		const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		expect(loadCoverageManifest(temporaryDirectory)).toBeUndefined();
		expect(spy).toHaveBeenCalledWith(expect.stringContaining("malformed JSON"));

		spy.mockRestore();
	});

	it("should warn and return undefined for schema-invalid manifest", () => {
		expect.assertions(2);

		const temporaryDirectory = createTemporaryDirectory("cov-test-");
		const coverageDirectory = path.join(temporaryDirectory, ".jest-roblox-coverage");
		fs.mkdirSync(coverageDirectory, { recursive: true });
		fs.writeFileSync(
			path.join(coverageDirectory, "manifest.json"),
			JSON.stringify({ wrong: "schema" }),
		);
		const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		expect(loadCoverageManifest(temporaryDirectory)).toBeUndefined();
		expect(spy).toHaveBeenCalledWith(expect.stringContaining("manifest is invalid"));

		spy.mockRestore();
	});

	it("should load valid manifest", () => {
		expect.assertions(2);

		const temporaryDirectory = createTemporaryDirectory("cov-test-");
		const coverageDirectory = path.join(temporaryDirectory, ".jest-roblox-coverage");
		fs.mkdirSync(coverageDirectory, { recursive: true });
		const manifest = {
			files: {
				"shared/player.luau": {
					key: "shared/player.luau",
					coverageMapPath: "shared/player.cov-map.json",
					instrumentedLuauPath: "shared/player.luau",
					originalLuauPath: "out/shared/player.luau",
					sourceMapPath: "out/shared/player.luau.map",
					statementCount: 10,
				},
			},
			generatedAt: "2026-01-01T00:00:00Z",
			luauRoots: ["out"],
			shadowDir: ".jest-roblox-coverage/out",
			version: 1,
		};
		fs.writeFileSync(path.join(coverageDirectory, "manifest.json"), JSON.stringify(manifest));
		const result = loadCoverageManifest(temporaryDirectory);

		expect(result).toBeDefined();
		expect(result!.files["shared/player.luau"]!.statementCount).toBe(10);
	});

	it("should skip invalid file records and warn to stderr", () => {
		expect.assertions(3);

		const temporaryDirectory = createTemporaryDirectory("cov-test-");
		const coverageDirectory = path.join(temporaryDirectory, ".jest-roblox-coverage");
		fs.mkdirSync(coverageDirectory, { recursive: true });
		const manifest = {
			files: {
				"shared/invalid.luau": { bad: "record" },
				"shared/valid.luau": {
					key: "shared/valid.luau",
					coverageMapPath: "shared/valid.cov-map.json",
					instrumentedLuauPath: "shared/valid.luau",
					originalLuauPath: "out/shared/valid.luau",
					sourceMapPath: "out/shared/valid.luau.map",
					statementCount: 5,
				},
			},
			generatedAt: "2026-01-01T00:00:00Z",
			luauRoots: ["out"],
			shadowDir: ".jest-roblox-coverage/out",
			version: 1,
		};
		fs.writeFileSync(path.join(coverageDirectory, "manifest.json"), JSON.stringify(manifest));
		const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		const result = loadCoverageManifest(temporaryDirectory);

		expect(result).toBeDefined();
		expect(result!.files["shared/invalid.luau"]).toBeUndefined();
		expect(spy).toHaveBeenCalledWith(expect.stringContaining("shared/invalid.luau"));

		spy.mockRestore();
	});
});
