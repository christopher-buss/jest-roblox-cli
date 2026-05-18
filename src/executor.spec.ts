import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import type { Backend, BackendOptions, BackendResult } from "./backends/interface.ts";
import type { ResolvedConfig } from "./config/schema.ts";
import { DEFAULT_CONFIG } from "./config/schema.ts";
import type { RawCoverageData } from "./coverage/types.ts";
import {
	type ExecuteResult,
	isLuauProject,
	loadCoverageManifest,
	readTsconfigMapping,
	resolveAllTsconfigMappings,
	resolveTsconfigDirectories,
	runProjects,
} from "./executor.ts";
import type { SnapshotWrites } from "./reporter/parser.ts";
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

interface ExecuteOptions {
	backend: Backend;
	config: ResolvedConfig;
	deferFormatting?: boolean;
	testFiles: Array<string>;
	version: string;
}

async function executeSingle(options: ExecuteOptions): Promise<ExecuteResult> {
	const { results } = await runProjects({
		backend: options.backend,
		deferFormatting: options.deferFormatting,
		projects: [{ config: options.config, testFiles: options.testFiles }],
		startTime: Date.now(),
		version: options.version,
	});

	return results[0]!;
}

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
	uploadMs: 50,
};

interface EntryInput {
	coverageData?: RawCoverageData;
	elapsedMs?: number;
	gameOutput?: string;
	luauTiming?: Record<string, number>;
	result: JestResult;
	setupSeconds?: number;
	snapshotWrites?: SnapshotWrites;
}

function buildJestOutputPayload(entry: EntryInput): string {
	const payload: Record<string, unknown> = { ...entry.result };
	if (entry.coverageData !== undefined) {
		payload["_coverage"] = entry.coverageData;
	}

	if (entry.luauTiming !== undefined) {
		payload["_timing"] = entry.luauTiming;
	}

	if (entry.setupSeconds !== undefined) {
		payload["_setup"] = entry.setupSeconds;
	}

	if (entry.snapshotWrites !== undefined) {
		payload["_snapshotWrites"] = entry.snapshotWrites;
	}

	return JSON.stringify(payload);
}

function singleEntryResult(
	entry: EntryInput,
	timing: BackendResult["timing"] = DEFAULT_TIMING,
): BackendResult {
	return {
		rawResults: [
			{
				entry: { elapsedMs: entry.elapsedMs, jestOutput: buildJestOutputPayload(entry) },
				fallbackGameOutput: entry.gameOutput,
			},
		],
		timing,
	};
}

function multiEntryResult(
	entries: Array<EntryInput>,
	timing: BackendResult["timing"] = DEFAULT_TIMING,
): BackendResult {
	return {
		rawResults: entries.map((entry) => {
			return {
				entry: { elapsedMs: entry.elapsedMs, jestOutput: buildJestOutputPayload(entry) },
				fallbackGameOutput: entry.gameOutput,
			};
		}),
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

describe("execute single-project helper", () => {
	it("should return exit code 0 when all tests pass", async () => {
		expect.assertions(2);

		const backend = createMockBackend(createPassingResult());
		const options: ExecuteOptions = {
			backend,
			config: DEFAULT_CONFIG,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await executeSingle(options);

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

		const result = await executeSingle(options);

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

		const result = await executeSingle(options);

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

		await executeSingle(options);

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

		const result = await executeSingle(options);

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

		const result = await executeSingle(options);

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

		const result = await executeSingle(options);

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

		const result = await executeSingle(options);

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

		const result = await executeSingle(options);

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

		const result = await executeSingle(options);

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

		const result = await executeSingle(options);

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

		const result = await executeSingle(options);

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

		const result = await executeSingle(options);

		expect(result.coverageData).toStrictEqual({
			"shared/player.luau": { b: undefined, f: undefined, s: { "0": 3, "1": 0, "2": 1 } },
		});
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

		const result = await executeSingle(options);

		// coverageData is still returned (backend always provides it), but
		// coverage processing is now handled by cli.ts
		expect(result.coverageData).toStrictEqual({
			"shared/player.luau": { b: undefined, f: undefined, s: { "0": 3, "1": 0, "2": 1 } },
		});
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

		const result = await executeSingle(options);

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

		const result = await executeSingle(options);

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

		const result = await executeSingle(options);

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

		const result = await executeSingle(options);

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
					{ executionMs: 100, uploadMs: 50 },
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
		const result = await executeSingle(options);

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

		const executeResult = await executeSingle(options);

		expect(executeResult.output).not.toContain(dataModelPath);
		expect(executeResult.result.testResults[0]!.testFilePath).toContain(
			"src/client/lib/test.spec",
		);
	});

	it("should exit non-zero when rojo project missing causes snapshot writes to fail", async () => {
		expect.assertions(2);

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
					{ executionMs: 100, uploadMs: 50 },
				);
			},
		};

		const options: ExecuteOptions = {
			backend,
			config: DEFAULT_CONFIG,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await executeSingle(options);

		expect(result.exitCode).toBe(1);
		expect(result.snapshotWriteFailures).toBe(1);
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
					{ executionMs: 100, uploadMs: 50 },
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

		const result = await executeSingle(options);

		expect(result.exitCode).toBe(0);

		const snapshotA = path.join(temporaryDirectory, "src/shared/__snapshots__/a.snap.luau");
		const snapshotB = path.join(temporaryDirectory, "src/shared/__snapshots__/b.snap.luau");

		expect(fs.existsSync(snapshotA)).toBeTrue();
		expect(fs.existsSync(snapshotB)).toBeTrue();
	});

	it("should report partial success in stderr when some writes fail", async () => {
		expect.assertions(1);

		const temporaryDirectory = createTemporaryDirectory("exec-snap-partial-");

		fs.writeFileSync(
			path.join(temporaryDirectory, "default.project.json"),
			JSON.stringify({
				name: "test",
				tree: { ReplicatedStorage: { $path: "src/shared" } },
			}),
		);

		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		const backend: Backend = {
			kind: "studio",
			runTests: async (): Promise<BackendResult> => {
				return singleEntryResult(
					{
						result: createPassingResult(),
						snapshotWrites: {
							"ReplicatedStorage/__snapshots__/a.snap.luau": "snap a",
							"UnknownService/__snapshots__/b.snap.luau": "snap b",
						},
					},
					{ executionMs: 100, uploadMs: 50 },
				);
			},
		};

		const config: ResolvedConfig = { ...DEFAULT_CONFIG, rootDir: temporaryDirectory };
		await executeSingle({
			backend,
			config,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		});

		const output = stderrSpy.mock.calls.map(([message]) => String(message)).join("");
		stderrSpy.mockRestore();

		expect(output).toMatch(/Wrote 1 of 2 snapshot files/);
	});

	it("should suppress success message when config.silent is true", async () => {
		expect.assertions(1);

		const temporaryDirectory = createTemporaryDirectory("exec-snap-silent-");

		fs.writeFileSync(
			path.join(temporaryDirectory, "default.project.json"),
			JSON.stringify({
				name: "test",
				tree: { ReplicatedStorage: { $path: "src/shared" } },
			}),
		);

		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		const backend: Backend = {
			kind: "studio",
			runTests: async (): Promise<BackendResult> => {
				return singleEntryResult(
					{
						result: createPassingResult(),
						snapshotWrites: {
							"ReplicatedStorage/__snapshots__/a.snap.luau": "snap a",
						},
					},
					{ executionMs: 100, uploadMs: 50 },
				);
			},
		};

		const config: ResolvedConfig = {
			...DEFAULT_CONFIG,
			rootDir: temporaryDirectory,
			silent: true,
		};
		await executeSingle({
			backend,
			config,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		});

		const output = stderrSpy.mock.calls.map(([message]) => String(message)).join("");
		stderrSpy.mockRestore();

		expect(output).not.toMatch(/Wrote \d+ snapshot/);
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
					{ executionMs: 100, uploadMs: 50 },
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

		const result = await executeSingle(options);

		expect(result.exitCode).toBe(0);
	});

	it("should resolve relative config.rojoProject against rootDir, not CWD", async () => {
		// Regression: in workspace mode CWD is the workspace root and a
		// relative `rojoProject` like "test.project.json" must resolve under
		// each package's `rootDir`, not where the CLI was invoked. Stub
		// process.cwd() to a sentinel that is NOT a parent of rootDir so the
		// resolution is unambiguous — without the rootDir-relative resolve
		// fs.existsSync would interpret the relative path against this CWD
		// sentinel and miss every package.
		expect.assertions(3);

		const temporaryDirectory = createTemporaryDirectory("exec-snap-root-dir-");
		const workspaceRoot = "/fake-workspace-root";
		vol.mkdirSync(workspaceRoot, { recursive: true });
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(workspaceRoot);

		const rojoProject = {
			name: "test",
			tree: { ReplicatedStorage: { $path: "src/shared" } },
		};
		fs.writeFileSync(
			path.join(temporaryDirectory, "test.project.json"),
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
							"ReplicatedStorage/__snapshots__/test.snap.luau": "snap content",
						},
					},
					{ executionMs: 100, uploadMs: 50 },
				);
			},
		};

		const config: ResolvedConfig = {
			...DEFAULT_CONFIG,
			rojoProject: "test.project.json",
			rootDir: temporaryDirectory,
		};
		await executeSingle({
			backend,
			config,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		});

		const output = stderrSpy.mock.calls.map(([message]) => String(message)).join("");
		stderrSpy.mockRestore();
		cwdSpy.mockRestore();

		// CWD-relative misresolution would land here and falsely "exist".
		expect(fs.existsSync(path.join(workspaceRoot, "test.project.json"))).toBeFalse();
		expect(output).not.toMatch(/Cannot write snapshots - no rojo project found/);

		const snapshotPath = path.join(
			temporaryDirectory,
			"src/shared/__snapshots__/test.snap.luau",
		);

		expect(fs.existsSync(snapshotPath)).toBeTrue();
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
					{ executionMs: 100, uploadMs: 50 },
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

		await executeSingle(options);

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
					{ executionMs: 100, uploadMs: 50 },
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

		await executeSingle(options);

		expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("invalid rojo project"));

		stderrSpy.mockRestore();
	});

	it("should warn distinctly when rojo project cannot be read", async () => {
		expect.assertions(3);

		const temporaryDirectory = createTemporaryDirectory("exec-snap-read-");

		// Create a directory where the rojo project file is expected;
		// fs.existsSync returns true, but fs.readFileSync throws EISDIR. The read
		// path should produce a "Cannot read" message, not "Failed to parse".
		fs.mkdirSync(path.join(temporaryDirectory, "default.project.json"));

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
					{ executionMs: 100, uploadMs: 50 },
				);
			},
		};

		const config: ResolvedConfig = { ...DEFAULT_CONFIG, rootDir: temporaryDirectory };
		await executeSingle({
			backend,
			config,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		});

		const output = stderrSpy.mock.calls.map(([message]) => String(message)).join("");
		stderrSpy.mockRestore();

		expect(output).toContain("Cannot read rojo project");
		expect(output).toContain("default.project.json");
		expect(output).not.toContain("Failed to parse rojo project");
	});

	it("should warn when resolveNestedProjects throws on a missing nested project", async () => {
		expect.assertions(2);

		const temporaryDirectory = createTemporaryDirectory("exec-snap-nested-");

		// A nested $path pointing at a non-existent file makes
		// resolveNestedProjects throw. This must surface as a write failure, not
		// abort the run.
		fs.writeFileSync(
			path.join(temporaryDirectory, "default.project.json"),
			JSON.stringify({
				name: "test",
				tree: { $path: "nested.project.json" },
			}),
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
					{ executionMs: 100, uploadMs: 50 },
				);
			},
		};

		const config: ResolvedConfig = { ...DEFAULT_CONFIG, rootDir: temporaryDirectory };
		const result = await executeSingle({
			backend,
			config,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		});

		const output = stderrSpy.mock.calls.map(([message]) => String(message)).join("");
		stderrSpy.mockRestore();

		expect(output).toContain("Cannot resolve rojo project tree");
		expect(result.snapshotWriteFailures).toBe(1);
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
					{ executionMs: 100, uploadMs: 50 },
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

		await executeSingle(options);

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
					{ executionMs: 100, uploadMs: 50 },
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

		await executeSingle(options);

		const output = stderrSpy.mock.calls.map(([message]) => String(message)).join("");
		stderrSpy.mockRestore();

		expect(output).toMatch(
			/Failed to write snapshot ReplicatedStorage\/__snapshots__\/test\.snap\.luau/,
		);
	});

	it("should expose snapshot write failures in Snapshot Write line", async () => {
		expect.assertions(1);

		const temporaryDirectory = createTemporaryDirectory("exec-snap-write-fail-");

		fs.writeFileSync(
			path.join(temporaryDirectory, "default.project.json"),
			JSON.stringify({ name: "test", tree: { ReplicatedStorage: { $path: "src/shared" } } }),
		);

		const backend: Backend = {
			kind: "studio",
			runTests: async (): Promise<BackendResult> => {
				return singleEntryResult(
					{
						result: createPassingResult(),
						snapshotWrites: {
							"UnknownService/__snapshots__/a.snap.luau": "snap a",
						},
					},
					{ executionMs: 100, uploadMs: 50 },
				);
			},
		};

		const config: ResolvedConfig = { ...DEFAULT_CONFIG, rootDir: temporaryDirectory };
		const result = await executeSingle({
			backend,
			config,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		});

		expect(stripVTControlCharacters(result.output)).toMatch(/Snapshot Write\s+1 failed/);
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
					{ executionMs: 100, uploadMs: 50 },
				);
			},
		};

		const config: ResolvedConfig = {
			...DEFAULT_CONFIG,
			rootDir: temporaryDirectory,
			silent: true,
		};

		await executeSingle({ backend, config, testFiles: [], version: "0.0.0-test" });

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
					{ executionMs: 100, uploadMs: 50 },
				);
			},
		};

		const config: ResolvedConfig = {
			...DEFAULT_CONFIG,
			rootDir: temporaryDirectory,
			silent: true,
		};

		await executeSingle({ backend, config, testFiles: [], version: "0.0.0-test" });

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
					{ executionMs: 100, uploadMs: 50 },
				);
			},
		};

		const config: ResolvedConfig = {
			...DEFAULT_CONFIG,
			rootDir: temporaryDirectory,
			silent: true,
		};

		await executeSingle({ backend, config, testFiles: [], version: "0.0.0-test" });

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

		const result = await executeSingle(options);

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

		const executeResult = await executeSingle(options);

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
					{ executionMs: 100, uploadMs: 50 },
				);
			},
		};

		const config: ResolvedConfig = { ...DEFAULT_CONFIG, rootDir: temporaryDirectory };
		await executeSingle({ backend, config, testFiles: [], version: "0.0.0-test" });

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

		const result = await executeSingle(options);

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

describe(loadCoverageManifest, () => {
	it("should return undefined when manifest file does not exist", () => {
		expect.assertions(1);

		const result = loadCoverageManifest("/nonexistent/dir");

		expect(result).toBeUndefined();
	});

	it("should warn and return undefined for malformed manifest JSON", () => {
		expect.assertions(2);

		const temporaryDirectory = createTemporaryDirectory("cov-test-");
		const coverageDirectory = path.join(temporaryDirectory, ".jest-roblox/coverage");
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
		const coverageDirectory = path.join(temporaryDirectory, ".jest-roblox/coverage");
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
		const coverageDirectory = path.join(temporaryDirectory, ".jest-roblox/coverage");
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
			shadowDir: ".jest-roblox/coverage/out",
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
		const coverageDirectory = path.join(temporaryDirectory, ".jest-roblox/coverage");
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
			shadowDir: ".jest-roblox/coverage/out",
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

describe(runProjects, () => {
	it("should return one processed result for a single project", async () => {
		expect.assertions(3);

		const backend = createMockBackend(createPassingResult());

		const { backendTiming, results } = await runProjects({
			backend,
			projects: [{ config: DEFAULT_CONFIG, testFiles: ["src/test.spec.ts"] }],
			startTime: Date.now(),
			version: "0.0.0-test",
		});

		expect(results).toHaveLength(1);
		expect(results[0]?.exitCode).toBe(0);
		expect(backendTiming.executionMs).toBe(100);
	});

	it("should return one ExecuteResult per project in input order", async () => {
		expect.assertions(3);

		const backend: Backend = {
			kind: "studio",
			runTests: async () => {
				return multiEntryResult([
					{ result: createPassingResult() },
					{ result: createFailingResult() },
				]);
			},
		};

		const { results } = await runProjects({
			backend,
			projects: [
				{
					config: DEFAULT_CONFIG,
					displayName: "first",
					testFiles: ["src/a.spec.ts"],
				},
				{
					config: DEFAULT_CONFIG,
					displayName: "second",
					testFiles: ["src/b.spec.ts"],
				},
			],
			startTime: Date.now(),
			version: "0.0.0-test",
		});

		expect(results).toHaveLength(2);
		expect(results[0]?.exitCode).toBe(0);
		expect(results[1]?.exitCode).toBe(1);
	});

	it("should forward parallel to backend.runTests", async () => {
		expect.assertions(1);

		let captured: BackendOptions | undefined;
		const backend: Backend = {
			kind: "open-cloud",
			runTests: async (options_) => {
				captured = options_;
				return singleEntryResult({ result: createPassingResult() });
			},
		};

		await runProjects({
			backend,
			parallel: 3,
			projects: [{ config: DEFAULT_CONFIG, testFiles: ["src/test.spec.ts"] }],
			startTime: Date.now(),
			version: "0.0.0-test",
		});

		expect(captured?.parallel).toBe(3);
	});

	it("should forward scriptOverride, workStealing, and streaming hooks", async () => {
		expect.assertions(3);

		let captured: BackendOptions | undefined;
		const backend: Backend = {
			kind: "open-cloud",
			runTests: async (options_) => {
				captured = options_;
				return singleEntryResult({ result: createPassingResult() });
			},
		};

		const streaming: NonNullable<BackendOptions["streaming"]> = fromAny({
			onPackageResult: () => {},
			reader: { read: async () => [] },
		});

		await runProjects({
			backend,
			projects: [{ config: DEFAULT_CONFIG, testFiles: ["src/test.spec.ts"] }],
			scriptOverride: "-- staged materializer",
			startTime: Date.now(),
			streaming,
			version: "0.0.0-test",
			workStealing: true,
		});

		expect(captured?.scriptOverride).toBe("-- staged materializer");
		expect(captured?.workStealing).toBeTrue();
		expect(captured?.streaming).toBe(streaming);
	});

	it("should post-process each result with its own project config", async () => {
		expect.assertions(2);

		const backend: Backend = {
			kind: "studio",
			runTests: async () => {
				return multiEntryResult([
					{ result: createPassingResult() },
					{ result: createPassingResult() },
				]);
			},
		};

		const { results } = await runProjects({
			backend,
			projects: [
				{
					config: { ...DEFAULT_CONFIG, silent: true },
					displayName: "silent",
					testFiles: ["src/a.spec.ts"],
				},
				{
					config: DEFAULT_CONFIG,
					displayName: "loud",
					testFiles: ["src/b.spec.ts"],
				},
			],
			startTime: Date.now(),
			version: "0.0.0-test",
		});

		expect(results[0]?.output).toBe("");
		expect(results[1]?.output).not.toBe("");
	});

	it("should share backend timing across every project result", async () => {
		expect.assertions(3);

		const backend: Backend = {
			kind: "open-cloud",
			runTests: async () => {
				return multiEntryResult(
					[{ result: createPassingResult() }, { result: createPassingResult() }],
					{ executionMs: 250, uploadMs: 75 },
				);
			},
		};

		const { backendTiming, results } = await runProjects({
			backend,
			projects: [
				{ config: DEFAULT_CONFIG, displayName: "first", testFiles: ["src/a.spec.ts"] },
				{ config: DEFAULT_CONFIG, displayName: "second", testFiles: ["src/b.spec.ts"] },
			],
			startTime: Date.now(),
			version: "0.0.0-test",
		});

		expect(backendTiming.executionMs).toBe(250);
		expect(results[0]?.timing.executionMs).toBe(250);
		expect(results[1]?.timing.executionMs).toBe(250);
	});

	it("should throw when backend rawResults length does not match jobs length", async () => {
		expect.assertions(1);

		const emptyResult: BackendResult = { rawResults: [], timing: DEFAULT_TIMING };
		const backend: Backend = {
			kind: "studio",
			runTests: async () => emptyResult,
		};

		const promise = runProjects({
			backend,
			projects: [
				{ config: DEFAULT_CONFIG, testFiles: ["src/a.spec.ts"] },
				{ config: DEFAULT_CONFIG, testFiles: ["src/b.spec.ts"] },
			],
			startTime: Date.now(),
			version: "0.0.0-test",
		});

		await expect(promise).rejects.toThrow(/rawResults must be parallel to jobs/);
	});

	it("should surface backend errors", async () => {
		expect.assertions(1);

		const backend: Backend = {
			kind: "open-cloud",
			runTests: async () => {
				throw new Error("backend exploded");
			},
		};

		const promise = runProjects({
			backend,
			projects: [{ config: DEFAULT_CONFIG, testFiles: ["src/test.spec.ts"] }],
			startTime: Date.now(),
			version: "0.0.0-test",
		});

		await expect(promise).rejects.toThrow("backend exploded");
	});

	it("should preserve displayColor, displayName, and pkg on jobs sent to the backend", async () => {
		expect.assertions(3);

		let captured: BackendOptions | undefined;
		const backend: Backend = {
			kind: "studio",
			runTests: async (options_) => {
				captured = options_;
				return singleEntryResult({ result: createPassingResult() });
			},
		};

		await runProjects({
			backend,
			projects: [
				{
					config: DEFAULT_CONFIG,
					displayColor: "green",
					displayName: "client",
					pkg: "@halcyon/client",
					testFiles: ["src/a.spec.ts"],
				},
			],
			startTime: Date.now(),
			version: "0.0.0-test",
		});

		expect(captured?.jobs[0]?.displayColor).toBe("green");
		expect(captured?.jobs[0]?.displayName).toBe("client");
		expect(captured?.jobs[0]?.pkg).toBe("@halcyon/client");
	});

	it("should apply per-project snapshotFormat defaults before backend dispatch", async () => {
		expect.assertions(2);

		let captured: BackendOptions | undefined;
		const backend: Backend = {
			kind: "studio",
			runTests: async (options_) => {
				captured = options_;
				return multiEntryResult([
					{ result: createPassingResult() },
					{ result: createPassingResult() },
				]);
			},
		};

		await runProjects({
			backend,
			projects: [
				{
					config: DEFAULT_CONFIG,
					displayName: "luau",
					testFiles: ["src/a.spec.luau"],
				},
				{
					config: DEFAULT_CONFIG,
					displayName: "ts",
					testFiles: ["src/b.spec.ts"],
				},
			],
			startTime: Date.now(),
			version: "0.0.0-test",
		});

		expect(captured?.jobs[0]?.config.snapshotFormat?.printBasicPrototype).toBeTrue();
		expect(captured?.jobs[1]?.config.snapshotFormat?.printBasicPrototype).toBeFalse();
	});
});
