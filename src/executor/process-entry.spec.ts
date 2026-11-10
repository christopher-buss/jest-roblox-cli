import { fromAny, fromPartial } from "@total-typescript/shoehorn";

import path from "node:path";
import process from "node:process";
import type { Except } from "type-fest";
import { describe, expect, it } from "vitest";

import { clockTimingCollector } from "#test/mocks/clock-timing-collector.ts";
import { createPassingResult } from "#test/mocks/executor-spec-results.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { projectJob } from "#test/mocks/project-job.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { RawBackendEntry } from "../backends/interface.ts";
import type { GapRecord } from "../gaps/gap-types.ts";
import type { ConfiguredJob, ExecuteResult } from "./executor-types.ts";
import { type EntryContext, processOrRecoverEntry } from "./process-entry.ts";

const FAILURE_ENVELOPE = JSON.stringify({ err: "Exited with code: 1", success: false });

function createContext(overrides: Partial<EntryContext> = {}): EntryContext {
	const { fileSystem, volume } = createMemoryFileSystem();
	volume.mkdirSync(process.cwd(), { recursive: true });
	return {
		backendTiming: { executionMs: 100, uploadMs: 50 },
		fileSystem,
		startTime: Date.now(),
		timing: clockTimingCollector(),
		tsconfigCache: new Map(),
		tsconfigReader: fromAny(() => null),
		...overrides,
	};
}

function createJob(overrides: Partial<ConfiguredJob> = {}): ConfiguredJob {
	return projectJob({
		config: createResolvedConfig(),
		displayName: "boom",
		testFiles: ["src/b.spec.ts"],
		...overrides,
	});
}

function processEntry(
	raw: Except<RawBackendEntry, "jobIndex">,
	{ context = createContext(), job = createJob() } = {},
): ExecuteResult {
	return processOrRecoverEntry({ context, job, raw: { ...raw, jobIndex: 0 } });
}

function failureMessageOf(result: ExecuteResult): string {
	return result.result.testResults[0]!.failureMessage!;
}

describe(processOrRecoverEntry, () => {
	it("should put a parsed entry's gaps on its tests", () => {
		expect.assertions(2);

		const file = "src/test.spec.ts";
		const result = processEntry({
			entry: { jestOutput: JSON.stringify({ ...createPassingResult(), runner: {} }) },
			gaps: fromPartial<GapRecord>({
				attributed: [
					{ file, gaps: {} },
					{ file, gaps: { "Sound.Pitch": 1 }, position: 1, test: "Test passes" },
					{ file, gaps: {}, position: 2, test: "Test also passes" },
				],
				unattributed: {},
			}),
		});

		expect(result.result.testResults[0]!.testResults.map((test) => test.gaps)).toStrictEqual([
			{ "Sound.Pitch": 1 },
			{},
		]);
		expect(result.exitCode).toBe(1);
	});

	it("should locate each test of a file under a relative Rojo mount", () => {
		expect.assertions(1);

		const context = createContext();
		context.fileSystem.writeFileSync(
			path.join(process.cwd(), "test.project.json"),
			JSON.stringify({
				name: "app",
				tree: { $className: "DataModel", ReplicatedStorage: { $path: "src" } },
			}),
		);
		context.fileSystem.mkdirSync(path.join(process.cwd(), "src"), { recursive: true });
		context.fileSystem.writeFileSync(
			path.join(process.cwd(), "src", "init.spec.luau"),
			"return function()\n\tit('passes')\nend\n",
		);
		const testFilePath = "/ReplicatedStorage/init.spec";
		const passing = createPassingResult();
		passing.testResults[0]!.testFilePath = testFilePath;
		passing.testResults[0]!.testResults[0]!.location = { column: 0, line: 2 };
		const runner = {
			perTestCoverage: [
				{
					delta: { "init.spec.luau": { s: [1] } },
					testCaseId: "Test passes",
					testFilePath,
				},
			],
		};

		const result = processEntry(
			{ entry: { jestOutput: JSON.stringify({ ...passing, runner }) } },
			{
				context,
				job: createJob({
					config: {
						...createResolvedConfig(),
						collectPerTestCoverage: true,
						rojoProject: "test.project.json",
						rootDir: process.cwd(),
						sourceMap: true,
					},
				}),
			},
		);

		expect(result.attribution!.tests[0]!.location).toStrictEqual({ column: 0, line: 2 });
	});

	it("should leave gaps off a parsed entry that reported none", () => {
		expect.assertions(2);

		const result = processEntry({
			entry: { jestOutput: JSON.stringify({ ...createPassingResult(), runner: {} }) },
		});

		expect(result.result.testResults[0]).not.toHaveProperty("gaps");
		expect(result.exitCode).toBe(0);
	});

	it("should put a recovered entry's gaps on its file", () => {
		expect.assertions(1);

		const result = processEntry({
			entry: { jestOutput: FAILURE_ENVELOPE },
			gaps: { attributed: [], unattributed: { script: 2 } },
		});

		expect(result.result.testResults[0]!.gaps).toStrictEqual({ script: 2 });
	});

	it("should use the exec-error result contract on the synthetic failure (failureMessage + empty testResults, counts stay 0)", () => {
		expect.assertions(4);

		const result = processEntry({ entry: { jestOutput: FAILURE_ENVELOPE } });

		// `hasExecError` is true when failureMessage is set AND testResults
		// is empty. Aggregate `numFailedTests` is 0 because no tests ran.
		expect(result.result.success).toBeFalse();
		expect(result.result.numFailedTests).toBe(0);
		expect(failureMessageOf(result)).toContain("Exited with code: 1");
		expect(result.result.testResults[0]!.testResults).toHaveLength(0);
	});

	it("should keep the raw error message when it is not an exit-code transport error", () => {
		expect.assertions(1);

		// bannerOutput compose only applies to the exit-code-only case
		// because that's where the real cause is hidden.
		const result = processEntry({
			entry: {
				bannerOutput: JSON.stringify([{ message: "noise", messageType: 0, timestamp: 0 }]),
				jestOutput: JSON.stringify({
					err: "Resolver crashed: invalid jest path",
					success: false,
				}),
			},
		});

		expect(failureMessageOf(result)).toBe("Resolver crashed: invalid jest path");
	});

	it("should fall back to the host's own report when bannerOutput entries are all blank", () => {
		expect.assertions(2);

		const result = processEntry({
			entry: {
				bannerOutput: JSON.stringify([{ message: "  ", messageType: 0, timestamp: 0 }]),
				jestOutput: FAILURE_ENVELOPE,
			},
		});

		expect(failureMessageOf(result)).toStartWith(
			"Jest exited before returning a result, and no cause was captured.",
		);
		expect(failureMessageOf(result)).toEndWith("Exited with code: 1");
	});

	it("should name the package, project and selected test files the host dispatched", () => {
		expect.assertions(2);

		const result = processEntry(
			{ entry: { jestOutput: FAILURE_ENVELOPE } },
			{
				job: createJob({
					displayName: "unit",
					pkg: "@scope/boom",
					testFiles: ["src/a.spec.ts", "src/b.spec.ts"],
				}),
			},
		);

		expect(failureMessageOf(result)).toContain("Project      @scope/boom › unit");
		expect(failureMessageOf(result)).toContain("Test files   2 selected by the host");
	});

	it("should carry the runner's phase and capture state into the report", () => {
		expect.assertions(2);

		const result = processEntry({
			entry: {
				jestOutput: JSON.stringify({
					err: "Exited with code: 1",
					runner: { captureInstalled: false, phase: "resolveJest" },
					success: false,
				}),
			},
		});

		expect(failureMessageOf(result)).toContain("Phase        resolving the Jest module");
		expect(failureMessageOf(result)).toContain(
			"Capture      stdout/stderr interception could not be installed",
		);
	});

	it("should compose failureMessage from bannerOutput when error is exit-code-only", () => {
		expect.assertions(3);

		const bannerOutput = JSON.stringify([
			{ message: "No tests found in /repo/packages/foo", messageType: 0, timestamp: 0 },
		]);
		const failureMessage = failureMessageOf(
			processEntry({ entry: { bannerOutput, jestOutput: FAILURE_ENVELOPE } }),
		);

		expect(failureMessage).toContain("No tests found in /repo/packages/foo");
		expect(failureMessage).toContain("Exited with code: 1");
		expect(failureMessage.indexOf("No tests found")).toBeLessThan(
			failureMessage.indexOf("Exited with code: 1"),
		);
	});

	it("should attach the rawResult's fallbackGameOutput to the synthetic failure", () => {
		expect.assertions(1);

		const result = processEntry(
			{ entry: { jestOutput: FAILURE_ENVELOPE }, fallbackGameOutput: "[{}]" },
			{ context: createContext() },
		);

		expect(result.gameOutput).toBe("[{}]");
	});

	it("should rethrow non-LuauScriptError failures so unexpected internal errors still surface", () => {
		expect.assertions(1);

		// `{}` parses as JSON but fails validateJestResult, which throws a
		// plain Error (not LuauScriptError).
		expect(() => processEntry({ entry: { jestOutput: "{}" } })).toThrow(/Invalid Jest result/);
	});
});
