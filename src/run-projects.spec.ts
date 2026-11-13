import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import process from "node:process";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";

import {
	createFailingResult,
	createMixedResult,
	createPassingResult,
} from "#test/mocks/executor-spec-results.ts";
import { fakeTimingCollector, phaseNamesOf } from "#test/mocks/fake-timing-collector.ts";
import type { MemoryFileSystem, MemoryVolume } from "#test/mocks/memory-file-system.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { Backend } from "./backends/dispatch-request.ts";
import type { BackendResult } from "./backends/interface.ts";
import type { OpenCloudDispatch } from "./backends/open-cloud-dispatch.ts";
import type { StreamingHooks } from "./backends/open-cloud-pool.ts";
import type { StudioDispatch } from "./backends/plugin-payload.ts";
import type { ResolvedConfig } from "./config/resolved-config.ts";
import type { RawCoverageData } from "./coverage-data/coverage-types.ts";
import type { PerTestCoverageEntry } from "./protocol/coverage.ts";
import type { SnapshotWrites } from "./protocol/runner-fields.ts";
import { type FormattedExecuteResult, runProjectsAsync } from "./run-projects.ts";
import type { TimingCollector } from "./timing/orchestration-collector.ts";
import type { TsconfigReader } from "./tsconfig/tsconfig-mappings.ts";
import type { JestResult } from "./types/jest-result-types.ts";
import type { FileSystem } from "./utils/file-system.ts";

interface ExecuteOptions {
	backend: Backend;
	config: ResolvedConfig;
	fileSystem?: FileSystem;
	testFiles: Array<string>;
	version: string;
}

/**
 * A tsconfig reader over one volume. `get-tsconfig` reads through a `node:fs`
 * binding of its own, so a run under an in-memory volume is handed this
 * instead, the same seam production hands the real reader.
 * @param fileSystem - Volume to read from.
 * @returns A reader that returns null when the file is missing or invalid.
 */
function readingVolume(fileSystem: FileSystem): TsconfigReader {
	return fromAny((searchPath: string, configName = "tsconfig.json") => {
		const filePath = path.join(path.resolve(searchPath), configName);
		try {
			const content = fileSystem.readFileSync(filePath, "utf-8");
			return {
				config: JSON.parse(content),
				path: filePath,
			};
		} catch {
			return null;
		}
	});
}

/**
 * A volume of its own, with the working directory already made: a run resolves
 * relative paths against it before it writes anything.
 * @returns The memory filesystem.
 */
function memoryFileSystem(): MemoryFileSystem {
	const memory = createMemoryFileSystem();
	memory.volume.mkdirSync(process.cwd(), { recursive: true });
	return memory;
}

async function runTimedAsync({
	backend,
	fileSystem,
	timing,
}: {
	backend: Backend;
	fileSystem: FileSystem;
	timing: TimingCollector;
}): ReturnType<typeof runProjectsAsync> {
	return runProjectsAsync({
		backend,
		fileSystem,
		projects: [{ config: createResolvedConfig(), testFiles: ["src/test.spec.ts"] }],
		runSettings: createResolvedConfig(),
		startTime: Date.now(),
		timing,
		tsconfigReader: readingVolume(fileSystem),
		version: "0.0.0-test",
	});
}

async function executeSingleAsync(options: ExecuteOptions): Promise<FormattedExecuteResult> {
	const fileSystem = options.fileSystem ?? memoryFileSystem().fileSystem;
	const { results } = await runProjectsAsync({
		backend: options.backend,
		fileSystem,
		projects: [{ config: options.config, testFiles: options.testFiles }],
		runSettings: createResolvedConfig(),
		startTime: Date.now(),
		tsconfigReader: readingVolume(fileSystem),
		version: options.version,
	});

	return results[0]!;
}

async function executeInRootAsync(
	backend: Backend,
	{ fileSystem, rootDirectory }: { fileSystem: FileSystem; rootDirectory: string },
): Promise<FormattedExecuteResult> {
	return executeSingleAsync({
		backend,
		config: { ...createResolvedConfig(), rootDir: rootDirectory },
		fileSystem,
		testFiles: ["src/test.spec.ts"],
		version: "0.0.0-test",
	});
}

function writtenText(spy: { mock: { calls: Array<Array<unknown>> } }): string {
	return spy.mock.calls.map(([message]) => String(message)).join("");
}

function writeRojoProject(
	{ fileSystem, rootDirectory }: { fileSystem: FileSystem; rootDirectory: string },
	project: Record<string, unknown>,
): void {
	fileSystem.writeFileSync(
		path.join(rootDirectory, "default.project.json"),
		JSON.stringify(project),
	);
}

function twoProjects(
	first: string,
	second: string,
): Array<{ config: ResolvedConfig; displayName: string; testFiles: Array<string> }> {
	return [
		{ config: createResolvedConfig(), displayName: first, testFiles: ["src/a.spec.ts"] },
		{ config: createResolvedConfig(), displayName: second, testFiles: ["src/b.spec.ts"] },
	];
}

async function runTwoProjectsAsync(
	backend: Backend,
	fileSystem: FileSystem,
): ReturnType<typeof runProjectsAsync> {
	return runProjectsAsync({
		backend,
		fileSystem,
		projects: twoProjects("first", "second"),
		runSettings: createResolvedConfig(),
		startTime: Date.now(),
		tsconfigReader: readingVolume(fileSystem),
		version: "0.0.0-test",
	});
}

async function executeSilentAsync(
	backend: Backend,
	{ fileSystem, rootDirectory }: { fileSystem: FileSystem; rootDirectory: string },
): Promise<void> {
	await executeSingleAsync({
		backend,
		config: { ...createResolvedConfig(), rootDir: rootDirectory, silent: true },
		fileSystem,
		testFiles: [],
		version: "0.0.0-test",
	});
}

function writeOutDirectoryProject(fileSystem: FileSystem, rootDirectory: string): void {
	fileSystem.writeFileSync(
		path.join(rootDirectory, "tsconfig.json"),
		JSON.stringify({ compilerOptions: { outDir: "./out-tsc/test", rootDir: "./src" } }),
	);
	writeRojoProject(
		{ fileSystem, rootDirectory },
		{
			name: "test",
			tree: { ReplicatedStorage: { $path: "out-tsc/test" } },
		},
	);
}

function writeNestedPackageProject(fileSystem: FileSystem, rootDirectory: string): void {
	writeRojoProject(
		{ fileSystem, rootDirectory },
		{
			name: "test",
			tree: {
				ReplicatedStorage: {
					"uuid-generator": { $path: "packages/uuid-generator/default.project.json" },
				},
			},
		},
	);
	const nestedDirectory = path.join(rootDirectory, "packages/uuid-generator");
	fileSystem.mkdirSync(nestedDirectory, { recursive: true });
	writeRojoProject(
		{ fileSystem, rootDirectory: nestedDirectory },
		{
			name: "uuid-generator",
			tree: { $path: "src" },
		},
	);
}

function playerCoverage(): RawCoverageData {
	return { "shared/player.luau": { s: { "0": 3, "1": 0, "2": 1 } } };
}

const DEFAULT_TIMING: BackendResult["timing"] = {
	executionMs: 100,
	uploadMs: 50,
};

interface EntryInput {
	coverageData?: RawCoverageData | undefined;
	gameOutput?: string | undefined;
	luauTiming?: Record<string, number> | undefined;
	perTestCoverage?: Array<PerTestCoverageEntry> | undefined;
	result: JestResult;
	setupSeconds?: number | undefined;
	snapshotWrites?: SnapshotWrites | undefined;
}

function buildJestOutputPayload(entry: EntryInput): string {
	const payload = {
		...entry.result,
		runner: {
			coverage: entry.coverageData,
			perTestCoverage: entry.perTestCoverage,
			setup: entry.setupSeconds,
			snapshotWrites: entry.snapshotWrites,
			timing: entry.luauTiming,
		},
	};

	return JSON.stringify(payload);
}

function singleEntryResult(
	entry: EntryInput,
	timing: BackendResult["timing"] = DEFAULT_TIMING,
): BackendResult {
	return {
		rawResults: [
			{
				entry: { jestOutput: buildJestOutputPayload(entry) },
				fallbackGameOutput: entry.gameOutput,
				jobIndex: 0,
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
		rawResults: entries.map((entry, jobIndex) => {
			return {
				entry: { jestOutput: buildJestOutputPayload(entry) },
				fallbackGameOutput: entry.gameOutput,
				jobIndex,
			};
		}),
		timing,
	};
}

function fakeStudioBackend(build: () => BackendResult): Backend {
	return {
		kind: "studio",
		runTestsAsync: async () => build(),
	};
}

function snapshotBackend(snapshotWrites: SnapshotWrites): Backend {
	return fakeStudioBackend(() => {
		return singleEntryResult({ result: createPassingResult(), snapshotWrites });
	});
}

function createMockBackend(result: JestResult, gameOutput?: string): Backend {
	return {
		kind: "studio",
		runTestsAsync: async (): Promise<BackendResult> => {
			return singleEntryResult({ gameOutput, result });
		},
	};
}

function createMockBackendWithCoverage(result: JestResult, coverageData: RawCoverageData): Backend {
	return {
		kind: "studio",
		runTestsAsync: async (): Promise<BackendResult> => {
			return singleEntryResult({ coverageData, result });
		},
	};
}

let temporaryDirectoryCounter = 0;

/**
 * A directory on `volume`, named apart from every other test's.
 *
 * @param volume - Where the directory is made.
 * @param prefix - What its name starts with.
 * @returns Absolute path of the directory.
 */
function createTemporaryDirectory(volume: MemoryVolume, prefix: string): string {
	const directory = path.resolve(`/tmp/${prefix}${temporaryDirectoryCounter}`);
	temporaryDirectoryCounter += 1;
	volume.mkdirSync(directory, { recursive: true });
	return directory;
}

describe("execute single-project helper", () => {
	it("should return exit code 0 when all tests pass", async () => {
		expect.assertions(2);

		const { fileSystem } = memoryFileSystem();

		const backend = createMockBackend(createPassingResult());
		const options: ExecuteOptions = {
			backend,
			config: createResolvedConfig(),
			fileSystem,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await executeSingleAsync(options);

		expect(result.exitCode).toBe(0);
		expect(result.result.success).toBeTrue();
	});

	it("should handle test results without duration", async () => {
		expect.assertions(1);

		const { fileSystem } = memoryFileSystem();

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
			config: createResolvedConfig(),
			fileSystem,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await executeSingleAsync(options);

		expect(result.exitCode).toBe(0);
	});

	it("should return exit code 1 when tests fail", async () => {
		expect.assertions(2);

		const { fileSystem } = memoryFileSystem();

		const backend = createMockBackend(createFailingResult());
		const options: ExecuteOptions = {
			backend,
			config: createResolvedConfig(),
			fileSystem,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await executeSingleAsync(options);

		expect(result.exitCode).toBe(1);
		expect(result.result.success).toBeFalse();
	});

	it("should pass test name pattern to backend", async () => {
		expect.assertions(1);

		const { fileSystem } = memoryFileSystem();

		let capturedOptions: StudioDispatch | undefined;
		const backend: Backend = {
			kind: "studio",
			runTestsAsync: async (runOptions: StudioDispatch): Promise<BackendResult> => {
				capturedOptions = runOptions;
				return singleEntryResult({ result: createPassingResult() });
			},
		};

		const config: ResolvedConfig = {
			...createResolvedConfig(),
			testNamePattern: "should pass",
		};
		const options: ExecuteOptions = {
			backend,
			config,
			fileSystem,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		await executeSingleAsync(options);

		expect(capturedOptions!.jobs[0].argv.testNamePattern).toBe("should pass");
	});

	it("should format output as human-readable by default", async () => {
		expect.assertions(2);

		const { fileSystem } = memoryFileSystem();

		const backend = createMockBackend(createPassingResult());
		const options: ExecuteOptions = {
			backend,
			config: createResolvedConfig(),
			fileSystem,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await executeSingleAsync(options);

		expect(result.output).toContain("✓");
		expect(result.output).toContain("2 passed");
	});

	it("should format output as JSON when json formatter is enabled", async () => {
		expect.assertions(2);

		const { fileSystem } = memoryFileSystem();

		const backend = createMockBackend(createPassingResult());
		const config: ResolvedConfig = { ...createResolvedConfig(), formatters: ["json"] };
		const options: ExecuteOptions = {
			backend,
			config,
			fileSystem,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await executeSingleAsync(options);

		const parsed = fromAny<JestResult, JSONValue>(JSON.parse(result.output));

		expect(parsed.success).toBeTrue();
		expect(parsed.numTotalTests).toBe(2);
	});

	it("should pass through gameOutput from backend", async () => {
		expect.assertions(1);

		const { fileSystem } = memoryFileSystem();

		const rawGameOutput = '[{"message":"hello","messageType":0,"timestamp":1000}]';
		const backend = createMockBackend(createPassingResult(), rawGameOutput);
		const options: ExecuteOptions = {
			backend,
			config: createResolvedConfig(),
			fileSystem,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await executeSingleAsync(options);

		expect(result.gameOutput).toBe(rawGameOutput);
	});

	it("should fall through to default formatter when agent and verbose are both set", async () => {
		expect.assertions(2);

		const { fileSystem } = memoryFileSystem();

		const backend = createMockBackend(createMixedResult());
		const config: ResolvedConfig = {
			...createResolvedConfig(),
			formatters: ["agent"],
			verbose: true,
		};
		const options: ExecuteOptions = {
			backend,
			config,
			fileSystem,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await executeSingleAsync(options);

		// Verbose output includes the human timing summary.
		expect(result.output).toContain("Duration");
		expect(result.output).toContain("Test Files");
	});

	it("should resolve outputFile and gameOutput paths when configured", async () => {
		expect.assertions(2);

		const { fileSystem } = memoryFileSystem();

		const backend = createMockBackend(createPassingResult());
		const config: ResolvedConfig = {
			...createResolvedConfig(),
			gameOutput: "./game-output.json",
			outputFile: "./results.json",
		};
		const options: ExecuteOptions = {
			backend,
			config,
			fileSystem,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await executeSingleAsync(options);

		expect(result.exitCode).toBe(0);
		expect(result.output).not.toBeEmpty();
	});

	it("should return empty output when silent", async () => {
		expect.assertions(1);

		const { fileSystem } = memoryFileSystem();

		const backend = createMockBackend(createPassingResult());
		const config: ResolvedConfig = { ...createResolvedConfig(), silent: true };
		const options: ExecuteOptions = {
			backend,
			config,
			fileSystem,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await executeSingleAsync(options);

		expect(result.output).toBe("");
	});

	it("should return timing in result", async () => {
		expect.assertions(4);

		const { fileSystem } = memoryFileSystem();

		const backend = createMockBackend(createPassingResult());
		const options: ExecuteOptions = {
			backend,
			config: createResolvedConfig(),
			fileSystem,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await executeSingleAsync(options);

		expect(result.timing.executionMs).toBe(100);
		expect(result.timing.uploadMs).toBe(50);
		expect(result.timing.totalMs).toBeGreaterThanOrEqual(0);
		expect(result.timing.testsMs).toBeGreaterThanOrEqual(0);
	});

	it("should calculate total timing from the supplied start time", async () => {
		expect.assertions(1);

		const { fileSystem } = memoryFileSystem();

		vi.spyOn(Date, "now").mockReturnValue(1_750);
		const { results } = await runProjectsAsync({
			backend: createMockBackend(createPassingResult()),
			fileSystem,
			projects: [
				{
					config: { ...createResolvedConfig(), sourceMap: false },
					testFiles: ["src/test.spec.ts"],
				},
			],
			runSettings: createResolvedConfig(),
			startTime: 1_250,
			tsconfigReader: readingVolume(fileSystem),
			version: "0.0.0-test",
		});

		expect(results[0]!.timing.totalMs).toBe(500);
	});

	it("should profile each orchestration boundary by its stable name", async () => {
		expect.assertions(1);

		const { fileSystem } = memoryFileSystem();
		const backend = snapshotBackend({
			"ReplicatedStorage/shared/__snapshots__/test.snap.luau": "snapshot content",
		});

		const profileNames: Array<string> = [];
		const timing: TimingCollector = fromAny({
			enabled: false,
			flushTimingReport: () => {},
			profile: (name: string, operation: () => unknown) => {
				profileNames.push(name);
				return operation();
			},
			profileAsync: async (name: string, operation: () => Promise<unknown>) => {
				profileNames.push(name);
				return operation();
			},
			record: () => {},
		});

		await runProjectsAsync({
			backend,
			fileSystem,
			projects: [
				{
					config: { ...createResolvedConfig(), sourceMap: true },
					testFiles: ["src/test.spec.ts"],
				},
			],
			runSettings: createResolvedConfig(),
			startTime: Date.now(),
			timing,
			tsconfigReader: readingVolume(fileSystem),
			version: "0.0.0-test",
		});

		expect(profileNames).toStrictEqual(
			expect.arrayContaining([
				"buildJobs",
				"backend.runTests",
				"processResults",
				"resolveTsconfigMappings",
				"buildSourceMapper",
				"writeSnapshots",
			]),
		);
	});

	it("should record uploadMs / executionMs spans under backend.runTests when timing is provided", async () => {
		expect.assertions(2);

		const { fileSystem } = memoryFileSystem();

		const timing = fakeTimingCollector();

		const backend = createMockBackend(createPassingResult());
		await runTimedAsync({ backend, fileSystem, timing });

		timing.flushTimingReport();

		expect(timing.record).toHaveBeenCalledWith("uploadMs", 50);
		expect(timing.record).toHaveBeenCalledWith("executionMs", 100);
	});

	it("should skip uploadMs span when backend did not measure an upload", async () => {
		expect.assertions(2);

		const { fileSystem } = memoryFileSystem();

		const timing = fakeTimingCollector();

		// Studio backend never uploads, so uploadMs is omitted from
		// BackendTiming. The orchestrator must skip the span instead of recording
		// a 0ms or emitting an "undefined ms" line.
		const studioBackend = fakeStudioBackend(() => {
			return singleEntryResult({ result: createPassingResult() }, { executionMs: 100 });
		});

		await runProjectsAsync({
			backend: studioBackend,
			fileSystem,
			projects: [{ config: createResolvedConfig(), testFiles: ["src/test.spec.ts"] }],
			runSettings: createResolvedConfig(),
			startTime: Date.now(),
			timing,
			tsconfigReader: readingVolume(fileSystem),
			version: "0.0.0-test",
		});

		timing.flushTimingReport();

		expect(timing.record).toHaveBeenCalledWith("executionMs", 100);
		expect(phaseNamesOf(timing.record)).not.toContain("uploadMs");
	});

	it("should record luau phase timings nested under backend.runTests", async () => {
		expect.assertions(2);

		const { fileSystem } = memoryFileSystem();

		const timing = fakeTimingCollector();

		const backend = fakeStudioBackend(() => {
			return singleEntryResult({
				luauTiming: { findJest: 0.1, jestRunCLI: 2.5 },
				result: createPassingResult(),
			});
		});

		await runTimedAsync({ backend, fileSystem, timing });

		timing.flushTimingReport();

		expect(timing.record).toHaveBeenCalledWith("luau.findJest", 100);
		expect(timing.record).toHaveBeenCalledWith("luau.jestRunCLI", 2500);
	});

	it("should skip the raw luau total phase to avoid a second host total", async () => {
		expect.assertions(2);

		const { fileSystem } = memoryFileSystem();

		const timing = fakeTimingCollector();

		const backend = fakeStudioBackend(() => {
			return singleEntryResult({
				luauTiming: { findJest: 0.1, total: 3 },
				result: createPassingResult(),
			});
		});

		await runTimedAsync({ backend, fileSystem, timing });

		timing.flushTimingReport();

		expect(timing.record).toHaveBeenCalledWith("luau.findJest", 100);
		expect(phaseNamesOf(timing.record)).not.toContain("luau.total");
	});

	it("should accumulate luau phase timings across multiple projects", async () => {
		expect.assertions(1);

		const { fileSystem } = memoryFileSystem();

		const timing = fakeTimingCollector();

		const backend = fakeStudioBackend(() => {
			return multiEntryResult([
				{ luauTiming: { findJest: 0.10025 }, result: createPassingResult() },
				{ luauTiming: { findJest: 0.20035 }, result: createPassingResult() },
			]);
		});

		await runProjectsAsync({
			backend,
			fileSystem,
			projects: [
				{ config: createResolvedConfig(), testFiles: ["src/a.spec.ts"] },
				{ config: createResolvedConfig(), testFiles: ["src/b.spec.ts"] },
			],
			runSettings: createResolvedConfig(),
			startTime: Date.now(),
			timing,
			tsconfigReader: readingVolume(fileSystem),
			version: "0.0.0-test",
		});

		timing.flushTimingReport();

		// 100.25ms + 200.35ms = 300.6ms. Sub-ms fractions must survive until
		// the emit-time round, not be rounded away per project.
		expect(
			vi
				.mocked(timing.record)
				.mock.calls.filter(([name]) => name === "luau.findJest")
				.map(([, ms]) => ms),
		).toStrictEqual([0.10025 * 1000, 0.20035 * 1000]);
	});

	it("should skip luau timing extraction entirely when the collector is disabled", async () => {
		expect.assertions(2);

		const { fileSystem } = memoryFileSystem();

		const timing: TimingCollector = { ...fakeTimingCollector(), enabled: false };

		const backend = fakeStudioBackend(() => {
			return singleEntryResult({
				luauTiming: { findJest: 0.1 },
				result: createPassingResult(),
			});
		});

		const { results } = await runTimedAsync({ backend, fileSystem, timing });

		expect(results[0]!.exitCode).toBe(0);
		expect(phaseNamesOf(timing.record).filter((name) => name.startsWith("luau."))).toBeEmpty();
	});

	it("should return coverageData when backend provides it", async () => {
		expect.assertions(1);

		const { fileSystem } = memoryFileSystem();

		const coverageData = playerCoverage();

		const backend = createMockBackendWithCoverage(createPassingResult(), coverageData);
		const config: ResolvedConfig = {
			...createResolvedConfig(),
			collectCoverage: true,
		};
		const options: ExecuteOptions = {
			backend,
			config,
			fileSystem,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await executeSingleAsync(options);

		expect(result.coverageData).toStrictEqual({
			"shared/player.luau": { s: { "0": 3, "1": 0, "2": 1 } },
		});
	});

	it("should pass through coverageData regardless of collectCoverage", async () => {
		expect.assertions(2);

		const { fileSystem } = memoryFileSystem();

		const coverageData = playerCoverage();

		const backend = createMockBackendWithCoverage(createPassingResult(), coverageData);
		const config: ResolvedConfig = { ...createResolvedConfig(), collectCoverage: false };
		const options: ExecuteOptions = {
			backend,
			config,
			fileSystem,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await executeSingleAsync(options);

		// coverageData is still returned (backend always provides it), but
		// coverage processing is now handled by cli.ts
		expect(result.coverageData).toStrictEqual({
			"shared/player.luau": { s: { "0": 3, "1": 0, "2": 1 } },
		});
		expect(result.attribution).toBeUndefined();
	});

	it("should not create attribution without coverage or per-test deltas", async () => {
		expect.assertions(1);

		const { fileSystem } = memoryFileSystem();

		const result = await executeSingleAsync({
			backend: createMockBackend(createPassingResult()),
			config: { ...createResolvedConfig(), collectPerTestCoverage: true },
			fileSystem,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		});

		expect(result.attribution).toBeUndefined();
	});

	it("should harvest per-test attribution when the backend provides it", async () => {
		expect.assertions(2);

		const { fileSystem } = memoryFileSystem();

		const perTestCoverage: Array<PerTestCoverageEntry> = [
			{
				delta: { "out/m.luau": { s: [1, 2] } },
				testCaseId: "math > adds",
				testFilePath: "out/m.spec.luau",
			},
		];
		const backend = fakeStudioBackend(() => {
			return singleEntryResult({ perTestCoverage, result: createPassingResult() });
		});
		const options: ExecuteOptions = {
			backend,
			config: { ...createResolvedConfig(), collectCoverage: true },
			fileSystem,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await executeSingleAsync(options);

		expect(result.attribution!.tests).toStrictEqual([
			{
				testCaseId: "math > adds",
				testFilePath: "out/m.spec.luau",
				testFileSourceHash: "",
				testId: "out/m.spec.luau::math > adds",
			},
		]);
		expect(result.attribution!.coveringTestIds).toStrictEqual({
			"out/m.luau": {
				"1": ["out/m.spec.luau::math > adds"],
				"2": ["out/m.spec.luau::math > adds"],
			},
		});
	});

	it("should derive the static set from the cumulative coverage and the deltas", async () => {
		expect.assertions(1);

		const { fileSystem } = memoryFileSystem();

		const perTestCoverage: Array<PerTestCoverageEntry> = [
			{
				delta: { "out/m.luau": { s: [1] } },
				testCaseId: "math > adds",
				testFilePath: "out/m.spec.luau",
			},
		];
		// Statement 0 is hit cumulatively but credited to no test → static.
		const coverageData: RawCoverageData = {
			"out/m.luau": { s: { "0": 1, "1": 2 } },
		};
		const backend = fakeStudioBackend(() => {
			return singleEntryResult({
				coverageData,
				perTestCoverage,
				result: createPassingResult(),
			});
		});
		const options: ExecuteOptions = {
			backend,
			config: { ...createResolvedConfig(), collectCoverage: true },
			fileSystem,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await executeSingleAsync(options);

		expect(result.attribution!.staticStatementIds).toStrictEqual({ "out/m.luau": ["0"] });
	});

	it("should derive an all-static set when per-test collection ran but credited nothing", async () => {
		expect.assertions(1);

		const { fileSystem } = memoryFileSystem();

		// No test covered anything new, so the runner emits no per-test entries
		// (parser returns undefined). Every cumulative hit ran outside a window.
		const coverageData: RawCoverageData = {
			"out/m.luau": { s: { "0": 1, "1": 1 } },
		};
		const backend = fakeStudioBackend(() => {
			return singleEntryResult({ coverageData, result: createPassingResult() });
		});
		const options: ExecuteOptions = {
			backend,
			config: {
				...createResolvedConfig(),
				collectCoverage: true,
				collectPerTestCoverage: true,
			},
			fileSystem,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await executeSingleAsync(options);

		expect(result.attribution!.staticStatementIds).toStrictEqual({ "out/m.luau": ["0", "1"] });
	});

	it("should not factor coverage into exit code", async () => {
		expect.assertions(1);

		const { fileSystem } = memoryFileSystem();

		const coverageData = playerCoverage();

		const backend = createMockBackendWithCoverage(createPassingResult(), coverageData);
		const config: ResolvedConfig = {
			...createResolvedConfig(),
			collectCoverage: true,
			coverageThreshold: { statements: 80 },
		};
		const options: ExecuteOptions = {
			backend,
			config,
			fileSystem,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await executeSingleAsync(options);

		// exit code is based only on test success, not coverage thresholds
		expect(result.exitCode).toBe(0);
	});

	it("should skip source mapper when sourceMap is false", async () => {
		expect.assertions(1);

		const { fileSystem } = memoryFileSystem();

		const backend = createMockBackend(createPassingResult());
		const config: ResolvedConfig = { ...createResolvedConfig(), sourceMap: false };
		const options: ExecuteOptions = {
			backend,
			config,
			fileSystem,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await executeSingleAsync(options);

		expect(result.exitCode).toBe(0);
	});

	it("should use agent formatter when agent is in formatters", async () => {
		expect.assertions(2);

		const { fileSystem } = memoryFileSystem();

		const backend = createMockBackend(createFailingResult());
		const config: ResolvedConfig = { ...createResolvedConfig(), formatters: ["agent"] };
		const options: ExecuteOptions = {
			backend,
			config,
			fileSystem,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await executeSingleAsync(options);

		// Agent output omits the human timing summary.
		expect(result.output).toContain("FAIL");
		expect(result.output).not.toContain("Duration");
	});

	it("should respect maxFailures from agent formatter options tuple", async () => {
		expect.assertions(1);

		const { fileSystem } = memoryFileSystem();

		const backend = createMockBackend(createFailingResult());
		const config: ResolvedConfig = {
			...createResolvedConfig(),
			formatters: [["agent", { maxFailures: 1 }]],
		};
		const options: ExecuteOptions = {
			backend,
			config,
			fileSystem,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await executeSingleAsync(options);

		expect(result.output).toContain("FAIL");
	});

	it("should handle backend providing luau timing", async () => {
		expect.assertions(1);

		const { fileSystem } = memoryFileSystem();

		const backend = fakeStudioBackend(() => {
			return singleEntryResult(
				{
					luauTiming: { requireJest: 1.5 },
					result: createPassingResult(),
				},
				{ executionMs: 100, uploadMs: 50 },
			);
		});

		const options: ExecuteOptions = {
			backend,
			config: createResolvedConfig(),
			fileSystem,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		// Should not throw when luauTiming is present
		const result = await executeSingleAsync(options);

		expect(result.exitCode).toBe(0);
	});

	it("should resolve DataModel testFilePaths to filesystem paths", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = memoryFileSystem();

		const temporaryDirectory = createTemporaryDirectory(volume, "executor-test-");
		writeRojoProject(
			{ fileSystem, rootDirectory: temporaryDirectory },
			{
				name: "test-game",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$className: "ReplicatedStorage",
						Client: { $path: "src/client" },
					},
				},
			},
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
			...createResolvedConfig(),
			rootDir: temporaryDirectory,
			sourceMap: true,
		};
		const options: ExecuteOptions = {
			backend,
			config,
			fileSystem,
			testFiles: ["src/client/lib/test.spec.luau"],
			version: "0.0.0-test",
		};

		const executeResult = await executeSingleAsync(options);

		expect(executeResult.output).not.toContain(dataModelPath);
		expect(executeResult.result.testResults[0]!.testFilePath).toContain(
			"src/client/lib/test.spec",
		);
	});

	it("should exit non-zero when rojo project missing causes snapshot writes to fail", async () => {
		expect.assertions(2);

		const { fileSystem } = memoryFileSystem();

		const backend = snapshotBackend({
			"ReplicatedStorage/shared/__snapshots__/test.snap.luau": "snapshot content",
		});

		const options: ExecuteOptions = {
			backend,
			config: createResolvedConfig(),
			fileSystem,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await executeSingleAsync(options);

		expect(result.exitCode).toBe(1);
		expect(result.snapshotWriteFailures).toBe(1);
	});

	it("should write multiple snapshots and use plural message", async () => {
		expect.assertions(3);

		const { fileSystem, volume } = memoryFileSystem();

		const temporaryDirectory = createTemporaryDirectory(volume, "exec-snap-");

		writeRojoProject(
			{ fileSystem, rootDirectory: temporaryDirectory },
			{
				name: "test",
				tree: { ReplicatedStorage: { $path: "src/shared" } },
			},
		);

		const backend = snapshotBackend({
			"ReplicatedStorage/__snapshots__/a.snap.luau": "snap a",
			"ReplicatedStorage/__snapshots__/b.snap.luau": "snap b",
		});

		const result = await executeInRootAsync(backend, {
			fileSystem,
			rootDirectory: temporaryDirectory,
		});

		expect(result.exitCode).toBe(0);

		const snapshotA = path.join(temporaryDirectory, "src/shared/__snapshots__/a.snap.luau");
		const snapshotB = path.join(temporaryDirectory, "src/shared/__snapshots__/b.snap.luau");

		expect(fileSystem.existsSync(snapshotA)).toBeTrue();
		expect(fileSystem.existsSync(snapshotB)).toBeTrue();
	});

	it("should report partial success in stderr when some writes fail", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = memoryFileSystem();

		const temporaryDirectory = createTemporaryDirectory(volume, "exec-snap-partial-");

		writeRojoProject(
			{ fileSystem, rootDirectory: temporaryDirectory },
			{
				name: "test",
				tree: { ReplicatedStorage: { $path: "src/shared" } },
			},
		);

		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		const backend = snapshotBackend({
			"ReplicatedStorage/__snapshots__/a.snap.luau": "snap a",
			"UnknownService/__snapshots__/b.snap.luau": "snap b",
		});

		await executeInRootAsync(backend, { fileSystem, rootDirectory: temporaryDirectory });

		const output = writtenText(stderrSpy);

		expect(output).toMatch(/Wrote 1 of 2 snapshot files/);
	});

	it("should suppress success message when config.silent is true", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = memoryFileSystem();

		const temporaryDirectory = createTemporaryDirectory(volume, "exec-snap-silent-");

		writeRojoProject(
			{ fileSystem, rootDirectory: temporaryDirectory },
			{
				name: "test",
				tree: { ReplicatedStorage: { $path: "src/shared" } },
			},
		);

		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		const backend = snapshotBackend({
			"ReplicatedStorage/__snapshots__/a.snap.luau": "snap a",
		});

		const config: ResolvedConfig = {
			...createResolvedConfig(),
			rootDir: temporaryDirectory,
			silent: true,
		};
		await executeSingleAsync({
			backend,
			config,
			fileSystem,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		});

		const output = writtenText(stderrSpy);

		expect(output).not.toMatch(/Wrote \d+ snapshot/);
	});

	it("should find non-default rojo project file", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = memoryFileSystem();

		const temporaryDirectory = createTemporaryDirectory(volume, "exec-snap-");

		const rojoProject = {
			name: "test",
			tree: { ReplicatedStorage: { $path: "out/shared" } },
		};
		fileSystem.writeFileSync(
			path.join(temporaryDirectory, "custom.project.json"),
			JSON.stringify(rojoProject),
		);

		const backend = snapshotBackend({
			"ReplicatedStorage/__snapshots__/test.snap.luau": "snap",
		});

		const result = await executeInRootAsync(backend, {
			fileSystem,
			rootDirectory: temporaryDirectory,
		});

		expect(result.exitCode).toBe(0);
	});

	it("should resolve relative config.rojoProject against rootDir, not CWD", async () => {
		// Regression: in workspace mode CWD is the workspace root and a
		// relative `rojoProject` like "test.project.json" must resolve under
		// each package's `rootDir`, not where the CLI was invoked. Stub
		// process.cwd() to a sentinel that is NOT a parent of rootDir so the
		// resolution is unambiguous. Without the rootDir-relative resolve
		// fs.existsSync would interpret the relative path against this CWD
		// sentinel and miss every package.
		expect.assertions(3);

		const { fileSystem, volume } = memoryFileSystem();

		const temporaryDirectory = createTemporaryDirectory(volume, "exec-snap-root-dir-");
		const workspaceRoot = "/fake-workspace-root";
		volume.mkdirSync(workspaceRoot, { recursive: true });
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(workspaceRoot);

		const rojoProject = {
			name: "test",
			tree: { ReplicatedStorage: { $path: "src/shared" } },
		};
		fileSystem.writeFileSync(
			path.join(temporaryDirectory, "test.project.json"),
			JSON.stringify(rojoProject),
		);

		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		const backend = snapshotBackend({
			"ReplicatedStorage/__snapshots__/test.snap.luau": "snap content",
		});

		const config: ResolvedConfig = {
			...createResolvedConfig(),
			rojoProject: "test.project.json",
			rootDir: temporaryDirectory,
		};
		await executeSingleAsync({
			backend,
			config,
			fileSystem,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		});

		const output = writtenText(stderrSpy);
		cwdSpy.mockRestore();

		// CWD-relative misresolution would land here and falsely "exist".
		expect(fileSystem.existsSync(path.join(workspaceRoot, "test.project.json"))).toBeFalse();
		expect(output).not.toMatch(/Cannot write snapshots - no rojo project found/);

		const snapshotPath = path.join(
			temporaryDirectory,
			"src/shared/__snapshots__/test.snap.luau",
		);

		expect(fileSystem.existsSync(snapshotPath)).toBeTrue();
	});

	it("should warn when snapshot path cannot be resolved", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = memoryFileSystem();

		const temporaryDirectory = createTemporaryDirectory(volume, "exec-snap-");

		writeRojoProject(
			{ fileSystem, rootDirectory: temporaryDirectory },
			{
				name: "test",
				tree: { ReplicatedStorage: { $path: "out/shared" } },
			},
		);

		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		const backend = snapshotBackend({
			"UnknownService/__snapshots__/test.snap.luau": "snap content",
		});

		await executeInRootAsync(backend, { fileSystem, rootDirectory: temporaryDirectory });

		expect(stderrSpy).toHaveBeenCalledWith(
			expect.stringContaining("Cannot resolve snapshot path"),
		);
	});

	it("should warn when rojo project has invalid schema for snapshots", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = memoryFileSystem();

		const temporaryDirectory = createTemporaryDirectory(volume, "exec-snap-");

		writeRojoProject({ fileSystem, rootDirectory: temporaryDirectory }, { invalid: "schema" });

		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		const backend = snapshotBackend({
			"ReplicatedStorage/__snapshots__/test.snap.luau": "snap",
		});

		await executeInRootAsync(backend, { fileSystem, rootDirectory: temporaryDirectory });

		expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid Rojo project"));
	});

	it("should warn distinctly when rojo project cannot be read", async () => {
		expect.assertions(3);

		const { fileSystem, volume } = memoryFileSystem();

		const temporaryDirectory = createTemporaryDirectory(volume, "exec-snap-read-");

		// Create a directory where the rojo project file is expected;
		// fs.existsSync returns true, but fs.readFileSync throws EISDIR. The read
		// path should produce a "Cannot read" message, not "Failed to parse".
		fileSystem.mkdirSync(path.join(temporaryDirectory, "default.project.json"));

		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		const backend = snapshotBackend({
			"ReplicatedStorage/__snapshots__/test.snap.luau": "snap",
		});

		await executeInRootAsync(backend, { fileSystem, rootDirectory: temporaryDirectory });

		const output = writtenText(stderrSpy);

		expect(output).toContain("Cannot read rojo project");
		expect(output).toContain("default.project.json");
		expect(output).not.toContain("Failed to parse Rojo project");
	});

	it("should warn when resolveNestedProjects throws on a missing nested project", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = memoryFileSystem();

		const temporaryDirectory = createTemporaryDirectory(volume, "exec-snap-nested-");

		// A nested $path pointing at a non-existent file makes
		// resolveNestedProjects throw. This must surface as a write failure, not
		// abort the run.
		writeRojoProject(
			{ fileSystem, rootDirectory: temporaryDirectory },
			{
				name: "test",
				tree: { $path: "nested.project.json" },
			},
		);

		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		const backend = snapshotBackend({
			"ReplicatedStorage/__snapshots__/test.snap.luau": "snap",
		});

		const result = await executeInRootAsync(backend, {
			fileSystem,
			rootDirectory: temporaryDirectory,
		});

		const output = writtenText(stderrSpy);

		expect(output).toContain("nested.project.json");
		expect(result.snapshotWriteFailures).toBe(1);
	});

	it("should warn with banner when rojo project JSON is invalid", async () => {
		expect.assertions(3);

		const { fileSystem, volume } = memoryFileSystem();

		const temporaryDirectory = createTemporaryDirectory(volume, "exec-snap-");

		// Valid file path but invalid JSON triggers SyntaxError catch branch
		fileSystem.writeFileSync(
			path.join(temporaryDirectory, "default.project.json"),
			"not valid json {{{",
		);

		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		const backend = snapshotBackend({
			"ReplicatedStorage/__snapshots__/test.snap.luau": "snap",
		});

		await executeInRootAsync(backend, { fileSystem, rootDirectory: temporaryDirectory });

		const output = writtenText(stderrSpy);

		expect(output).toContain("Snapshot Warning");
		expect(output).toContain("Failed to parse Rojo project");
		expect(output).toContain("default.project.json");
	});

	it("should warn generically when snapshot write throws non-SyntaxError", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = memoryFileSystem();

		const temporaryDirectory = createTemporaryDirectory(volume, "exec-snap-");

		writeRojoProject(
			{ fileSystem, rootDirectory: temporaryDirectory },
			{
				name: "test",
				tree: { ReplicatedStorage: { $path: "out/shared" } },
			},
		);

		// Create a file where mkdirSync expects a directory, causing a
		// non-SyntaxError when writing the snapshot
		const snapshotsPath = path.join(temporaryDirectory, "out/shared/__snapshots__");
		fileSystem.mkdirSync(path.join(temporaryDirectory, "out/shared"), { recursive: true });
		fileSystem.writeFileSync(snapshotsPath, "blocker");

		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		const backend = snapshotBackend({
			"ReplicatedStorage/__snapshots__/test.snap.luau": "snap",
		});

		const config: ResolvedConfig = { ...createResolvedConfig(), rootDir: temporaryDirectory };
		const options: ExecuteOptions = {
			backend,
			config,
			fileSystem,
			testFiles: [],
			version: "0.0.0-test",
		};

		await executeSingleAsync(options);

		const output = writtenText(stderrSpy);

		expect(output).toMatch(
			/Failed to write snapshot ReplicatedStorage\/__snapshots__\/test\.snap\.luau/,
		);
	});

	it("should expose snapshot write failures in Snapshot Write line", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = memoryFileSystem();

		const temporaryDirectory = createTemporaryDirectory(volume, "exec-snap-write-fail-");

		writeRojoProject(
			{ fileSystem, rootDirectory: temporaryDirectory },
			{
				name: "test",
				tree: { ReplicatedStorage: { $path: "src/shared" } },
			},
		);

		const backend = snapshotBackend({
			"UnknownService/__snapshots__/a.snap.luau": "snap a",
		});

		const result = await executeInRootAsync(backend, {
			fileSystem,
			rootDirectory: temporaryDirectory,
		});

		expect(stripVTControlCharacters(result.output)).toMatch(/Snapshot Write\s+1 failed/);
	});

	it("should resolve tsconfig outDir for snapshot source rewriting", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = memoryFileSystem();

		const temporaryDirectory = createTemporaryDirectory(volume, "exec-snap-tsconfig-");

		writeOutDirectoryProject(fileSystem, temporaryDirectory);

		const backend = snapshotBackend({
			"ReplicatedStorage/__snapshots__/test.spec.snap.luau": "-- snapshot",
		});

		await executeSilentAsync(backend, { fileSystem, rootDirectory: temporaryDirectory });

		const sourceSnapshot = path.join(
			temporaryDirectory,
			"src/__snapshots__/test.spec.snap.luau",
		);

		expect(fileSystem.existsSync(sourceSnapshot)).toBeTrue();
	});

	it("should dual-write snapshots to both source and out directories", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = memoryFileSystem();

		const temporaryDirectory = createTemporaryDirectory(volume, "exec-snap-dual-");

		writeOutDirectoryProject(fileSystem, temporaryDirectory);

		const backend = snapshotBackend({
			"ReplicatedStorage/__snapshots__/test.spec.snap.luau": "-- snapshot",
		});

		await executeSilentAsync(backend, { fileSystem, rootDirectory: temporaryDirectory });

		const sourceSnapshot = path.join(
			temporaryDirectory,
			"src/__snapshots__/test.spec.snap.luau",
		);
		const outSnapshot = path.join(
			temporaryDirectory,
			"out-tsc/test/__snapshots__/test.spec.snap.luau",
		);

		expect(fileSystem.existsSync(sourceSnapshot)).toBeTrue();
		expect(fileSystem.existsSync(outSnapshot)).toBeTrue();
	});

	// cspell:ignore rootdirs testrc
	it("should dual-write snapshots correctly when tsconfig uses rootDirs (rootDir collapses to '.')", async () => {
		expect.assertions(3);

		const { fileSystem, volume } = memoryFileSystem();

		const temporaryDirectory = createTemporaryDirectory(volume, "exec-snap-rootdirs-");

		// Mirrors tsconfig.spec.json with `rootDirs: ["src", "test"]`, which
		// collapses to rootDir "." in parseTsconfigMappings. Without the fix,
		// the dual-write computes "out-test" + "src/...".slice(1) =
		// "out-testrc/..." instead of "out-test/src/...".
		fileSystem.writeFileSync(
			path.join(temporaryDirectory, "tsconfig.spec.json"),
			JSON.stringify({
				compilerOptions: { outDir: "out-test", rootDirs: ["src", "test"] },
			}),
		);
		writeRojoProject(
			{ fileSystem, rootDirectory: temporaryDirectory },
			{
				name: "test",
				tree: {
					ReplicatedStorage: { "shared-tests": { $path: "out-test/src/shared" } },
				},
			},
		);

		const backend = snapshotBackend({
			"ReplicatedStorage/shared-tests/foo/__snapshots__/Bar.spec.snap.luau": "-- snapshot",
		});

		await executeSilentAsync(backend, { fileSystem, rootDirectory: temporaryDirectory });

		const sourceSnapshot = path.join(
			temporaryDirectory,
			"src/shared/foo/__snapshots__/Bar.spec.snap.luau",
		);
		const outSnapshot = path.join(
			temporaryDirectory,
			"out-test/src/shared/foo/__snapshots__/Bar.spec.snap.luau",
		);
		const corruptedSnapshot = path.join(
			temporaryDirectory,
			"out-testrc/shared/foo/__snapshots__/Bar.spec.snap.luau",
		);

		expect(fileSystem.existsSync(sourceSnapshot)).toBeTrue();
		expect(fileSystem.existsSync(outSnapshot)).toBeTrue();
		expect(fileSystem.existsSync(corruptedSnapshot)).toBeFalse();
	});

	it("should fall back to rojo-resolved path when no tsconfig exists", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = memoryFileSystem();

		const temporaryDirectory = createTemporaryDirectory(volume, "exec-snap-no-tsconfig-");

		writeRojoProject(
			{ fileSystem, rootDirectory: temporaryDirectory },
			{
				name: "test",
				tree: { ReplicatedStorage: { $path: "out-tsc/test" } },
			},
		);

		const backend = snapshotBackend({
			"ReplicatedStorage/__snapshots__/test.spec.snap.luau": "-- snapshot",
		});

		await executeSilentAsync(backend, { fileSystem, rootDirectory: temporaryDirectory });

		// No tsconfig → no outDir/rootDir rewriting → lands at rojo-resolved path
		const outSnapshot = path.join(
			temporaryDirectory,
			"out-tsc/test/__snapshots__/test.spec.snap.luau",
		);
		const sourceSnapshot = path.join(
			temporaryDirectory,
			"src/__snapshots__/test.spec.snap.luau",
		);

		expect(fileSystem.existsSync(outSnapshot)).toBeTrue();
		expect(fileSystem.existsSync(sourceSnapshot)).toBeFalse();
	});

	it("should build source mapper when rojo project exists", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = memoryFileSystem();

		const temporaryDirectory = createTemporaryDirectory(volume, "exec-sm-");

		writeRojoProject(
			{ fileSystem, rootDirectory: temporaryDirectory },
			{
				name: "test",
				tree: { ReplicatedStorage: { $path: "out/shared" } },
			},
		);

		const backend = createMockBackend(createFailingResult());
		const config: ResolvedConfig = {
			...createResolvedConfig(),
			rootDir: temporaryDirectory,
			sourceMap: true,
		};
		const options: ExecuteOptions = {
			backend,
			config,
			fileSystem,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await executeSingleAsync(options);

		// Source mapper was built (failure messages won't contain rojo paths
		// though)
		expect(result.exitCode).toBe(1);
	});

	it("should resolve test file paths through nested rojo projects", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = memoryFileSystem();

		const temporaryDirectory = createTemporaryDirectory(volume, "exec-nested-rojo-");

		writeNestedPackageProject(fileSystem, temporaryDirectory);

		// Backend returns DataModel path as Jest would
		const result = createPassingResult();
		result.testResults[0]!.testFilePath = "/ReplicatedStorage/uuid-generator/init.spec";
		const backend = createMockBackend(result);

		const config: ResolvedConfig = {
			...createResolvedConfig(),
			rootDir: temporaryDirectory,
			sourceMap: true,
		};
		const options: ExecuteOptions = {
			backend,
			config,
			fileSystem,
			testFiles: ["packages/uuid-generator/src/init.spec.luau"],
			version: "0.0.0-test",
		};

		const executeResult = await executeSingleAsync(options);

		expect(executeResult.result.testResults[0]!.testFilePath).toBe(
			`${temporaryDirectory.replaceAll("\\", "/")}/packages/uuid-generator/src/init.spec.luau`,
		);
	});

	it("should write snapshots through nested rojo projects", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = memoryFileSystem();

		const temporaryDirectory = createTemporaryDirectory(volume, "exec-nested-snap-");

		writeNestedPackageProject(fileSystem, temporaryDirectory);

		const backend = snapshotBackend({
			"ReplicatedStorage/uuid-generator/__snapshots__/init.spec.snap.luau": "-- snapshot",
		});

		const config: ResolvedConfig = { ...createResolvedConfig(), rootDir: temporaryDirectory };
		await executeSingleAsync({
			backend,
			config,
			fileSystem,
			testFiles: [],
			version: "0.0.0-test",
		});

		const snapshotPath = path.join(
			temporaryDirectory,
			"packages/uuid-generator/src/__snapshots__/init.spec.snap.luau",
		);

		expect(fileSystem.existsSync(snapshotPath)).toBeTrue();
	});

	it("should return undefined source mapper when rojo project has invalid schema", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = memoryFileSystem();

		const temporaryDirectory = createTemporaryDirectory(volume, "exec-sm-");

		writeRojoProject({ fileSystem, rootDirectory: temporaryDirectory }, { invalid: "schema" });

		const backend = createMockBackend(createPassingResult());
		const config: ResolvedConfig = {
			...createResolvedConfig(),
			rootDir: temporaryDirectory,
			sourceMap: true,
		};
		const options: ExecuteOptions = {
			backend,
			config,
			fileSystem,
			testFiles: ["src/test.spec.ts"],
			version: "0.0.0-test",
		};

		const result = await executeSingleAsync(options);

		expect(result.exitCode).toBe(0);
	});
});

describe(runProjectsAsync, () => {
	it("should return one processed result for a single project", async () => {
		expect.assertions(3);

		const { fileSystem } = memoryFileSystem();

		const backend = createMockBackend(createPassingResult());

		const { backendTiming, results } = await runProjectsAsync({
			backend,
			fileSystem,
			projects: [{ config: createResolvedConfig(), testFiles: ["src/test.spec.ts"] }],
			runSettings: createResolvedConfig(),
			startTime: Date.now(),
			tsconfigReader: readingVolume(fileSystem),
			version: "0.0.0-test",
		});

		expect(results).toHaveLength(1);
		expect(results[0]!.exitCode).toBe(0);
		expect(backendTiming.executionMs).toBe(100);
	});

	it("should return one ExecuteResult per project in input order", async () => {
		expect.assertions(3);

		const { fileSystem } = memoryFileSystem();

		const backend = fakeStudioBackend(() => {
			return multiEntryResult([
				{ result: createPassingResult() },
				{ result: createFailingResult() },
			]);
		});

		const { results } = await runTwoProjectsAsync(backend, fileSystem);

		expect(results).toHaveLength(2);
		expect(results[0]!.exitCode).toBe(0);
		expect(results[1]!.exitCode).toBe(1);
	});

	it("should forward parallel to backend.runTests", async () => {
		expect.assertions(1);

		const { fileSystem } = memoryFileSystem();

		let captured: OpenCloudDispatch | undefined;
		const backend: Backend = {
			kind: "open-cloud",
			runTestsAsync: async (runOptions: OpenCloudDispatch) => {
				captured = runOptions;
				return singleEntryResult({ result: createPassingResult() });
			},
		};

		await runProjectsAsync({
			backend,
			fileSystem,
			parallel: 3,
			projects: [{ config: createResolvedConfig(), testFiles: ["src/test.spec.ts"] }],
			runSettings: createResolvedConfig(),
			startTime: Date.now(),
			tsconfigReader: readingVolume(fileSystem),
			version: "0.0.0-test",
		});

		expect(captured!.sharding).toStrictEqual({ kind: "static", parallel: 3 });
	});

	it("should forward the workspace sharding", async () => {
		expect.assertions(1);

		const { fileSystem } = memoryFileSystem();

		let captured: OpenCloudDispatch | undefined;
		const backend: Backend = {
			kind: "open-cloud",
			runTestsAsync: async (runOptions: OpenCloudDispatch) => {
				captured = runOptions;
				return singleEntryResult({ result: createPassingResult() });
			},
		};

		const onPackageResult = vi.fn<StreamingHooks["onPackageResult"]>();

		await runProjectsAsync({
			backend,
			fileSystem,
			parallel: 2,
			projects: [{ config: createResolvedConfig(), testFiles: ["src/test.spec.ts"] }],
			runSettings: createResolvedConfig(),
			startTime: Date.now(),
			tsconfigReader: readingVolume(fileSystem),
			version: "0.0.0-test",
			workspace: { onPackageResult },
		});

		expect(captured!.sharding).toStrictEqual({
			bail: false,
			kind: "work-stealing",
			onPackageResult,
			parallel: 2,
		});
	});

	it("should forward --bail to the backend", async () => {
		expect.assertions(1);

		const { fileSystem } = memoryFileSystem();

		let captured: StudioDispatch | undefined;
		const backend: Backend = {
			kind: "studio",
			runTestsAsync: async (runOptions: StudioDispatch) => {
				captured = runOptions;
				return singleEntryResult({ result: createPassingResult() });
			},
		};

		await runProjectsAsync({
			backend,
			bail: true,
			fileSystem,
			projects: [{ config: createResolvedConfig(), testFiles: ["src/test.spec.ts"] }],
			runSettings: createResolvedConfig(),
			startTime: Date.now(),
			tsconfigReader: readingVolume(fileSystem),
			version: "0.0.0-test",
		});

		expect(captured!.bail).toBeTrue();
	});

	it("should post-process each result with its own project config", async () => {
		expect.assertions(2);

		const { fileSystem } = memoryFileSystem();

		const backend = fakeStudioBackend(() => {
			return multiEntryResult([
				{ result: createPassingResult() },
				{ result: createPassingResult() },
			]);
		});

		const { results } = await runProjectsAsync({
			backend,
			fileSystem,
			projects: [
				{
					config: { ...createResolvedConfig(), silent: true },
					displayName: "silent",
					testFiles: ["src/a.spec.ts"],
				},
				{
					config: createResolvedConfig(),
					displayName: "loud",
					testFiles: ["src/b.spec.ts"],
				},
			],
			runSettings: createResolvedConfig(),
			startTime: Date.now(),
			tsconfigReader: readingVolume(fileSystem),
			version: "0.0.0-test",
		});

		expect(results[0]!.output).toBe("");
		expect(results[1]!.output).not.toBe("");
	});

	it("should share backend timing across every project result", async () => {
		expect.assertions(3);

		const { fileSystem } = memoryFileSystem();

		const backend: Backend = {
			kind: "open-cloud",
			runTestsAsync: async () => {
				return multiEntryResult(
					[{ result: createPassingResult() }, { result: createPassingResult() }],
					{ executionMs: 250, uploadMs: 75 },
				);
			},
		};

		const { backendTiming, results } = await runTwoProjectsAsync(backend, fileSystem);

		expect(backendTiming.executionMs).toBe(250);
		expect(results[0]!.timing.executionMs).toBe(250);
		expect(results[1]!.timing.executionMs).toBe(250);
	});

	it.for([
		{
			name: "a job is missing from a run that did not bail",
			bailed: undefined,
			jobIndices: [0],
			message: "Backend returned no result for 1 job(s): beta",
		},
		{
			name: "every job is missing from a run that did not bail",
			bailed: undefined,
			jobIndices: [],
			message: "Backend returned no result for 2 job(s): alpha, beta",
		},
		{
			name: "a result names a job past the end",
			bailed: true,
			jobIndices: [0, 2],
			message: "Backend returned a result for job 2, but the run has 2 jobs",
		},
		{
			name: "a result names a negative job",
			bailed: true,
			jobIndices: [-1],
			message: "Backend returned a result for job -1, but the run has 2 jobs",
		},
		{
			name: "two results name one job",
			bailed: true,
			jobIndices: [1, 1],
			message: "Backend returned two results for job 1 (beta)",
		},
	])("should throw when $name", async ({ bailed, jobIndices, message }) => {
		expect.assertions(1);

		const { fileSystem } = memoryFileSystem();

		const backend: Backend = {
			kind: "studio",
			runTestsAsync: async () => {
				return {
					bailed,
					rawResults: jobIndices.map((jobIndex) => {
						return {
							entry: {
								jestOutput: buildJestOutputPayload({
									result: createPassingResult(),
								}),
							},
							jobIndex,
						};
					}),
					timing: DEFAULT_TIMING,
				};
			},
		};

		const promise = runProjectsAsync({
			backend,
			fileSystem,
			projects: [
				{
					config: createResolvedConfig(),
					displayName: "alpha",
					testFiles: ["src/a.spec.ts"],
				},
				{
					config: createResolvedConfig(),
					displayName: "beta",
					testFiles: ["src/b.spec.ts"],
				},
			],
			runSettings: createResolvedConfig(),
			startTime: Date.now(),
			tsconfigReader: readingVolume(fileSystem),
			version: "0.0.0-test",
		});

		await expect(promise).rejects.toThrow(message);
	});

	it("should give results in job order whatever order the backend returned them", async () => {
		expect.assertions(1);

		const { fileSystem } = memoryFileSystem();

		const backend: Backend = {
			kind: "studio",
			runTestsAsync: async () => {
				return {
					rawResults: [1, 0].map((jobIndex) => {
						return {
							entry: {
								jestOutput: buildJestOutputPayload({
									result: createPassingResult(),
								}),
							},
							jobIndex,
						};
					}),
					timing: DEFAULT_TIMING,
				};
			},
		};

		const { results } = await runProjectsAsync({
			backend,
			fileSystem,
			projects: [
				{ config: createResolvedConfig(), testFiles: ["src/a.spec.ts"] },
				{ config: createResolvedConfig(), testFiles: ["src/b.spec.ts"] },
			],
			runSettings: createResolvedConfig(),
			startTime: Date.now(),
			tsconfigReader: readingVolume(fileSystem),
			version: "0.0.0-test",
		});

		expect(results.map(({ jobIndex }) => jobIndex)).toStrictEqual([0, 1]);
	});

	// A bailing backend returns fewer entries than jobs on purpose; each
	// result names its job so the caller can line it up with its own
	// per-package state.
	it("should process only the jobs a bailing backend ran", async () => {
		expect.assertions(3);

		const { fileSystem, volume } = memoryFileSystem();

		const temporaryDirectory = createTemporaryDirectory(volume, "exec-bail-");
		writeRojoProject(
			{ fileSystem, rootDirectory: temporaryDirectory },
			{
				name: "test",
				tree: { ReplicatedStorage: { $path: "src/shared" } },
			},
		);
		const mappedConfig = { ...createResolvedConfig(), rootDir: temporaryDirectory };

		const backend: Backend = {
			kind: "open-cloud",
			runTestsAsync: async () => {
				const result = singleEntryResult({ result: createPassingResult() });
				return {
					...result,
					bailed: true,
					rawResults: result.rawResults.map((raw) => ({ ...raw, jobIndex: 2 })),
				};
			},
		};

		const { results } = await runProjectsAsync({
			backend,
			fileSystem,
			projects: [
				{ config: createResolvedConfig(), testFiles: ["src/a.spec.ts"] },
				{ config: createResolvedConfig(), testFiles: ["src/b.spec.ts"] },
				{ config: mappedConfig, testFiles: ["src/c.spec.ts"] },
			],
			runSettings: createResolvedConfig(),
			startTime: Date.now(),
			tsconfigReader: readingVolume(fileSystem),
			version: "0.0.0-test",
		});

		expect(results).toHaveLength(1);
		expect(results[0]!.jobIndex).toBe(2);
		// Only the last project's rootDir holds a rojo project, so a source
		// mapper here proves the one entry was paired with that project's
		// config rather than with the job sitting at the entry's own index.
		expect(results[0]!.sourceMapper).toBeDefined();
	});

	it("should surface backend errors", async () => {
		expect.assertions(1);

		const { fileSystem } = memoryFileSystem();

		const backend: Backend = {
			kind: "open-cloud",
			runTestsAsync: async () => {
				throw new Error("backend exploded");
			},
		};

		const promise = runProjectsAsync({
			backend,
			fileSystem,
			projects: [{ config: createResolvedConfig(), testFiles: ["src/test.spec.ts"] }],
			runSettings: createResolvedConfig(),
			startTime: Date.now(),
			tsconfigReader: readingVolume(fileSystem),
			version: "0.0.0-test",
		});

		await expect(promise).rejects.toThrow("backend exploded");
	});

	it("should preserve displayColor, displayName, and pkg on jobs sent to the backend", async () => {
		expect.assertions(3);

		const { fileSystem } = memoryFileSystem();

		let captured: StudioDispatch | undefined;
		const backend: Backend = {
			kind: "studio",
			runTestsAsync: async (runOptions: StudioDispatch) => {
				captured = runOptions;
				return singleEntryResult({ result: createPassingResult() });
			},
		};

		await runProjectsAsync({
			backend,
			fileSystem,
			projects: [
				{
					config: createResolvedConfig(),
					displayColor: "green",
					displayName: "client",
					pkg: "@halcyon/client",
					testFiles: ["src/a.spec.ts"],
				},
			],
			runSettings: createResolvedConfig(),
			startTime: Date.now(),
			tsconfigReader: readingVolume(fileSystem),
			version: "0.0.0-test",
		});

		expect(captured!.jobs[0].displayColor).toBe("green");
		expect(captured!.jobs[0].displayName).toBe("client");
		expect(captured!.jobs[0].pkg).toBe("@halcyon/client");
	});

	it("should normalize a missing display name to an empty runtime label", async () => {
		expect.assertions(2);

		const { fileSystem } = memoryFileSystem();

		let captured: StudioDispatch | undefined;
		const backend: Backend = {
			kind: "studio",
			runTestsAsync: async (runOptions: StudioDispatch) => {
				captured = runOptions;
				return singleEntryResult({ result: createPassingResult() });
			},
		};

		const { results } = await runProjectsAsync({
			backend,
			fileSystem,
			projects: [{ config: createResolvedConfig(), testFiles: ["src/a.spec.ts"] }],
			runSettings: createResolvedConfig(),
			startTime: Date.now(),
			tsconfigReader: readingVolume(fileSystem),
			version: "0.0.0-test",
		});

		expect(captured!.jobs[0].displayName).toBe("");
		expect(results[0]!.snapshotWriteFailures).toBeUndefined();
	});

	it("should apply per-project snapshotFormat defaults before backend dispatch", async () => {
		expect.assertions(2);

		const { fileSystem } = memoryFileSystem();

		let captured: StudioDispatch | undefined;
		const backend: Backend = {
			kind: "studio",
			runTestsAsync: async (runOptions: StudioDispatch) => {
				captured = runOptions;
				return multiEntryResult([
					{ result: createPassingResult() },
					{ result: createPassingResult() },
				]);
			},
		};

		await runProjectsAsync({
			backend,
			fileSystem,
			projects: [
				{
					config: createResolvedConfig(),
					displayName: "luau",
					testFiles: ["src/a.spec.luau"],
				},
				{
					config: createResolvedConfig(),
					displayName: "ts",
					testFiles: ["src/b.spec.ts"],
				},
			],
			runSettings: createResolvedConfig(),
			startTime: Date.now(),
			tsconfigReader: readingVolume(fileSystem),
			version: "0.0.0-test",
		});

		expect(captured!.jobs[0].argv.snapshotFormat!.printBasicPrototype).toBeTrue();
		expect(captured!.jobs[1]!.argv.snapshotFormat!.printBasicPrototype).toBeFalse();
	});

	// Parse failures on one entry must not halt sibling processing.
	// The Luau-side runEntry's per-entry pcall encodes deferred Promise
	// rejections (Jest's exit(1)) as `{success:false, err:...}` envelopes;
	// the CLI must convert that into a synthetic failed ExecuteResult so
	// the surrounding workspace pipeline (snapshot writes, per-package
	// output files) still runs for sibling entries.
	describe("per-entry parse failure recovery", () => {
		const failureEnvelope = JSON.stringify({
			err: "Exited with code: 1",
			success: false,
		});

		function backendReturning(result: BackendResult): Backend {
			return {
				kind: "open-cloud",
				runTestsAsync: async () => result,
			};
		}

		it("should keep processing siblings and emit a failed ExecuteResult for the bad entry", async () => {
			expect.assertions(3);

			const { fileSystem } = memoryFileSystem();

			const passingPayload = buildJestOutputPayload({ result: createPassingResult() });
			const backendResult: BackendResult = {
				rawResults: [
					{ entry: { jestOutput: passingPayload }, jobIndex: 0 },
					{ entry: { jestOutput: failureEnvelope }, jobIndex: 1 },
				],
				timing: DEFAULT_TIMING,
			};

			const { results } = await runProjectsAsync({
				backend: backendReturning(backendResult),
				fileSystem,
				projects: twoProjects("ok", "boom"),
				runSettings: createResolvedConfig(),
				startTime: Date.now(),
				tsconfigReader: readingVolume(fileSystem),
				version: "0.0.0-test",
			});

			expect(results).toHaveLength(2);
			expect(results[0]!.exitCode).toBe(0);
			expect(results[1]!.exitCode).toBe(1);
		});
	});
});
