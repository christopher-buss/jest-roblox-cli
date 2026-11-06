import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createMemoryFileSystem, type MemoryVolume } from "#test/mocks/memory-file-system.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { ResolvedConfig } from "./config/schema.ts";
import type { ExecuteResult } from "./executor/executor-types.ts";
import { writeResultFileAsync, writeSingleRunSinksAsync } from "./output-sinks.ts";
import type { JestResult } from "./types/jest-result-types.ts";

function makeJestResult(overrides: Partial<JestResult> = {}): JestResult {
	return {
		numFailedTests: 0,
		numPassedTests: 1,
		numPendingTests: 0,
		numTodoTests: 0,
		numTotalTests: 1,
		startTime: 1000,
		success: true,
		testResults: [],
		...overrides,
	};
}

const GAME_OUTPUT_ENTRY = { message: "hi", messageType: 0, timestamp: 0 };
const RAW_GAME_OUTPUT = JSON.stringify([GAME_OUTPUT_ENTRY]);

function makeExecuteResult(overrides: Partial<ExecuteResult> = {}): ExecuteResult {
	return {
		exitCode: 0,
		output: "",
		result: makeJestResult(),
		timing: { executionMs: 100, startTime: 1000, testsMs: 50, totalMs: 200, uploadMs: 50 },
		...overrides,
	};
}

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return { ...createResolvedConfig(), rootDir: "/test", ...overrides };
}

async function writeSingleAsync({
	config,
	runtimeResult,
	typecheckResult,
}: {
	config: ResolvedConfig;
	runtimeResult: ExecuteResult;
	typecheckResult?: JestResult;
}) {
	const { fileSystem, volume } = createMemoryFileSystem();
	const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

	await writeSingleRunSinksAsync({
		config,
		fileSystem,
		mergedResult: runtimeResult.result,
		runtimeResult,
		typecheckResult,
	});

	return { consoleError, volume };
}

/**
 * On Windows a bare "/tmp/x" and its resolved form are two different volume keys.
 * @param volume - Volume to read from.
 * @param filePath - Sink path as the code under test named it.
 * @returns The file contents.
 */
function readSink(volume: MemoryVolume, filePath: string): string {
	return String(volume.readFileSync(path.resolve(filePath), "utf8"));
}

describe(writeResultFileAsync, () => {
	it("should serialize the shared mergeResults output to the given path", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const typecheck = makeJestResult({ numPassedTests: 1, numTotalTests: 1 });
		const runtime = makeJestResult({ numPassedTests: 2, numTotalTests: 2 });

		await writeResultFileAsync({
			fileSystem,
			outputFile: "/tmp/results.json",
			rootDir: "/repo",
			runtime,
			typecheck,
		});

		expect(readSink(volume, "/tmp/results.json")).toBe(
			JSON.stringify(
				{
					numFailedTests: 0,
					numPassedTests: 3,
					numPendingTests: 0,
					numTodoTests: 0,
					numTotalTests: 3,
					startTime: 1000,
					success: true,
					testResults: [],
				},
				null,
				2,
			),
		);
	});

	it("should be a no-op when outputFile is undefined", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		await writeResultFileAsync({
			fileSystem,
			outputFile: undefined,
			rootDir: "/repo",
			runtime: makeJestResult(),
			typecheck: makeJestResult(),
		});

		expect(volume.toJSON()).toStrictEqual({});
	});

	it("should collapse to the present side when only one result is given", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const typecheck = makeJestResult({ numFailedTests: 1, success: false });

		await writeResultFileAsync({
			fileSystem,
			outputFile: "/tmp/results.json",
			rootDir: "/repo",
			runtime: undefined,
			typecheck,
		});

		expect(readSink(volume, "/tmp/results.json")).toBe(JSON.stringify(typecheck, null, 2));
	});
});

describe(writeSingleRunSinksAsync, () => {
	it("should write game output when config.gameOutput is set and runtime present", async () => {
		expect.assertions(2);

		const { consoleError, volume } = await writeSingleAsync({
			config: makeConfig({ gameOutput: "/tmp/game.json" }),
			runtimeResult: makeExecuteResult({ gameOutput: RAW_GAME_OUTPUT }),
		});

		expect(readSink(volume, "/tmp/game.json")).toBe(
			JSON.stringify([GAME_OUTPUT_ENTRY], null, 2),
		);
		expect(consoleError).toHaveBeenCalledExactlyOnceWith(
			"Game output (1 entries) written to /tmp/game.json",
		);
	});

	it("should suppress the game output notice when the run failed", async () => {
		expect.assertions(2);

		const { consoleError, volume } = await writeSingleAsync({
			config: makeConfig({ gameOutput: "/tmp/game.json" }),
			runtimeResult: makeExecuteResult({
				gameOutput: RAW_GAME_OUTPUT,
				result: makeJestResult({ success: false }),
			}),
		});

		expect(volume.existsSync(path.resolve("/tmp/game.json"))).toBeTrue();
		expect(consoleError).not.toHaveBeenCalled();
	});

	it("should suppress the game output notice under silent", async () => {
		expect.assertions(2);

		const { consoleError, volume } = await writeSingleAsync({
			config: makeConfig({ gameOutput: "/tmp/game.json", silent: true }),
			runtimeResult: makeExecuteResult({ gameOutput: RAW_GAME_OUTPUT }),
		});

		expect(volume.existsSync(path.resolve("/tmp/game.json"))).toBeTrue();
		expect(consoleError).not.toHaveBeenCalled();
	});

	it("should suppress the game output notice when there are no entries", async () => {
		expect.assertions(2);

		const { consoleError, volume } = await writeSingleAsync({
			config: makeConfig({ gameOutput: "/tmp/game.json" }),
			runtimeResult: makeExecuteResult(),
		});

		expect(readSink(volume, "/tmp/game.json")).toBe("[]");
		expect(consoleError).not.toHaveBeenCalled();
	});

	it("should write exactly the shared mergeResults output", async () => {
		expect.assertions(1);

		const typecheckResult = makeJestResult({ numFailedTests: 1, success: false });
		const runtime = makeJestResult({ numPassedTests: 3, numTotalTests: 3 });

		const { volume } = await writeSingleAsync({
			config: makeConfig({ outputFile: "/tmp/results.json" }),
			runtimeResult: makeExecuteResult({ result: runtime }),
			typecheckResult,
		});

		expect(readSink(volume, "/tmp/results.json")).toBe(
			JSON.stringify(
				{
					numFailedTests: 1,
					numPassedTests: 4,
					numPendingTests: 0,
					numTodoTests: 0,
					numTotalTests: 4,
					startTime: 1000,
					success: false,
					testResults: [],
				},
				null,
				2,
			),
		);
	});
});
