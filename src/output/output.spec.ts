import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import process from "node:process";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { createMemoryFileSystem, type MemoryVolume } from "#test/mocks/memory-file-system.ts";
import { mappedFile } from "#test/mocks/spec-coverage.ts";
import {
	makeBlockedResult,
	makeExecuteResult,
	makeJestResult,
	makeOutputConfig,
	setupOutputSpies,
} from "#test/mocks/spec-results.ts";
import type { ResolvedConfig } from "../config/resolved-config.ts";
import type { MappedCoverageResult } from "../coverage-report/mapper-types.ts";
import type { checkThresholds, generateReports } from "../coverage-report/reporter.ts";
import type { ExecuteResult } from "../executor/executor-types.ts";
import { outputRunAsync } from "./output.ts";
import type {
	CoverageReportUnit,
	OutputSettings,
	ProjectResult,
	RunResult,
} from "../results/run-result-types.ts";
import type { GameOutputEntry } from "../protocol/game-output.ts";
import type { JestResult, TestCaseResult } from "../types/jest-result-types.ts";
import type { FileSystem } from "../utils/file-system.ts";

type OutputDependencies = NonNullable<Parameters<typeof outputRunAsync>[0]["dependencies"]>;

interface OutputHarness {
	dependencies: OutputDependencies;
	fileSystem: FileSystem;
	volume: MemoryVolume;
}

const GAME_OUTPUT_ENTRY: GameOutputEntry = { message: "hi", messageType: 0, timestamp: 0 };
const RAW_GAME_OUTPUT = JSON.stringify([GAME_OUTPUT_ENTRY]);
const COVERAGE_HEADER = "Coverage report from";

const pipeline = {
	checkThresholds: vi.fn<typeof checkThresholds>(),
	generateReports: vi.fn<typeof generateReports>(),
};

interface SingleFixture {
	coverageMs: number;
	runtimeResult?: ExecuteResult | undefined;
	stagingMs: number;
	typecheckResult?: JestResult | undefined;
}

function makeFailingResult(): JestResult {
	return makeJestResult({
		numFailedTests: 1,
		numPassedTests: 0,
		success: false,
		testResults: [
			{
				numFailingTests: 1,
				numPassingTests: 0,
				numPendingTests: 0,
				testFilePath: "src/client/player.spec.ts",
				testResults: [
					{
						ancestorTitles: ["player"],
						duration: 1,
						failureMessages: ["boom"],
						fullName: "player explodes",
						status: "failed",
						title: "explodes",
					},
				],
			},
		],
	});
}

function makeSingleResult(overrides: Partial<SingleFixture> = {}): SingleFixture {
	return {
		coverageMs: 0,
		runtimeResult: makeExecuteResult(),
		stagingMs: 0,
		...overrides,
	};
}

function makeProjectResult(displayName = "client", executeOverrides = {}): ProjectResult {
	return {
		displayName,
		result: makeExecuteResult(executeOverrides),
	};
}

function makeMultiResult(overrides: Partial<RunResult> = {}): RunResult {
	return {
		coverageMs: 0,
		projectResults: [makeProjectResult()],
		stagingMs: 0,
		...overrides,
	};
}

async function outputOneProjectAsync({
	config,
	dependencies,
	result,
}: {
	config: ResolvedConfig;
	dependencies: OutputDependencies;
	result: SingleFixture;
}): Promise<number> {
	const { coverageMs, runtimeResult, stagingMs, typecheckResult } = result;
	return outputMultiResultAsync({
		dependencies,
		result: makeMultiResult({
			coverageMs,
			projectResults:
				runtimeResult === undefined
					? []
					: [{ displayName: "client", result: runtimeResult }],
			stagingMs,
			typecheckResult,
		}),
		rootConfig: config,
	});
}

function settingsOf(config: ResolvedConfig): OutputSettings {
	return {
		collectCoverage: config.collectCoverage,
		color: config.color,
		formatters: config.formatters,
		gameOutput: config.gameOutput,
		outputFile: config.outputFile,
		perUnitGameOutput: false,
		perUnitOutputFile: false,
		rootDir: config.rootDir,
		showLuau: config.showLuau,
		silent: config.silent,
		slowTestThreshold: config.slowTestThreshold,
		verbose: config.verbose,
	};
}

async function outputMultiResultAsync({
	dependencies,
	result,
	rootConfig,
}: {
	dependencies?: OutputDependencies;
	result: RunResult;
	rootConfig: ResolvedConfig;
}): Promise<number> {
	return outputRunAsync({
		...(dependencies === undefined ? {} : { dependencies }),
		result: { output: settingsOf(rootConfig), ...result },
	});
}

function makeReportOptions(overrides: Partial<OutputSettings> = {}): OutputSettings {
	return {
		collectCoverage: false,
		color: true,
		formatters: ["default"],
		perUnitGameOutput: false,
		perUnitOutputFile: false,
		rootDir: "/workspace",
		showLuau: true,
		silent: false,
		verbose: false,
		...overrides,
	};
}

function makeCoverageGate(
	overrides: Partial<CoverageReportUnit> = {},
): CoverageReportUnit {
	return {
		coverageDirectory: "/workspace/packages/foo/coverage",
		label: "@halcyon/foo",
		reporters: ["text", "lcov"],
		universe: fromAny({ files: { "foo.ts": {} } }),
		...overrides,
	};
}

function makeWorkspaceResult(overrides: Partial<RunResult> = {}): RunResult {
	const result: RunResult = {
		coverageMs: 0,
		output: makeReportOptions(),
		projectResults: [makeProjectResult("@halcyon/foo")],
		stagingMs: 0,
		...overrides,
	};
	const collectCoverage = (result.coverage?.units.length ?? 0) > 0;
	return { ...result, output: { ...makeReportOptions(), ...result.output, collectCoverage } };
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

function hasSink(volume: MemoryVolume, filePath: string): boolean {
	return volume.existsSync(path.resolve(filePath));
}

function setupOutput(): OutputHarness {
	onTestFinished(() => {
		delete process.env["GITHUB_STEP_SUMMARY"];
	});

	pipeline.checkThresholds.mockReturnValue({ failures: [], passed: true });

	const { fileSystem, volume } = createMemoryFileSystem();

	return {
		dependencies: { coveragePipeline: pipeline, fileSystem },
		fileSystem,
		volume,
	};
}

describe("a one-project run", () => {
	it("should print the gap summary on stderr", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		const spies = setupOutputSpies();

		await outputOneProjectAsync({
			config: makeOutputConfig(),
			dependencies,
			result: makeSingleResult({
				runtimeResult: makeExecuteResult({
					result: makeBlockedResult("src/gap.spec.ts", "reaches a gap"),
				}),
			}),
		});

		expect(spies.consoleError).toHaveBeenCalledWith(
			"Blocked (1):\n  src/gap.spec.ts > reaches a gap\n    script  1 raise",
		);
	});

	it("should not print the gap summary when silent", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		const spies = setupOutputSpies();

		await outputOneProjectAsync({
			config: makeOutputConfig({ silent: true }),
			dependencies,
			result: makeSingleResult({
				runtimeResult: makeExecuteResult({
					result: makeBlockedResult("src/gap.spec.ts", "reaches a gap"),
				}),
			}),
		});

		expect(spies.consoleError).not.toHaveBeenCalledWith(expect.stringContaining("Blocked"));
	});

	it("should return 1 when runtime fails", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		setupOutputSpies();

		const code = await outputOneProjectAsync({
			config: makeOutputConfig(),
			dependencies,
			result: makeSingleResult({
				runtimeResult: makeExecuteResult({ result: makeJestResult({ success: false }) }),
			}),
		});

		expect(code).toBe(1);
	});

	it("should return 1 when snapshot writes failed even if tests passed", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		setupOutputSpies();

		const code = await outputOneProjectAsync({
			config: makeOutputConfig(),
			dependencies,
			result: makeSingleResult({
				runtimeResult: makeExecuteResult({ snapshotWriteFailures: 2 }),
			}),
		});

		expect(code).toBe(1);
	});

	it("should return 1 when obsolete snapshots are present even if tests passed", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		setupOutputSpies();

		const code = await outputOneProjectAsync({
			config: makeOutputConfig(),
			dependencies,
			result: makeSingleResult({
				runtimeResult: makeExecuteResult({
					result: makeJestResult({
						snapshot: {
							added: 0,
							matched: 1,
							total: 1,
							unchecked: 2,
							unmatched: 0,
							updated: 0,
						},
					}),
				}),
			}),
		});

		expect(code).toBe(1);
	});

	// A bail is a test failure that ended the run early, not a run-level error,
	// so it exits the same 1 an ordinary failing package does.
	it("should return 1 when a bail stopped the run on a failing package", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		setupOutputSpies();

		const code = await outputMultiResultAsync({
			dependencies,
			result: makeWorkspaceResult({
				bail: { notRun: 2, ran: 1 },
				projectResults: [
					makeProjectResult("@halcyon/foo", {
						result: makeJestResult({ numFailedTests: 1, success: false }),
					}),
				],
			}),
			rootConfig: makeOutputConfig(),
		});

		expect(code).toBe(1);
	});

	it("should suppress output when config.silent is true", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		const spies = setupOutputSpies();

		await outputOneProjectAsync({
			config: makeOutputConfig({ silent: true }),
			dependencies,
			result: makeSingleResult(),
		});

		expect(spies.consoleLog).not.toHaveBeenCalled();
	});

	it("should suppress the final coverage status when silent", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		const spies = setupOutputSpies();

		await outputOneProjectAsync({
			config: makeOutputConfig({ collectCoverage: true, silent: true }),
			dependencies,
			result: makeSingleResult(),
		});

		expect(spies.stdout).not.toHaveBeenCalled();
	});

	it("should write JSON output when config.outputFile is set", async () => {
		expect.assertions(1);

		const { dependencies, volume } = setupOutput();
		setupOutputSpies();

		await outputOneProjectAsync({
			config: makeOutputConfig({ outputFile: "/tmp/results.json" }),
			dependencies,
			result: makeSingleResult(),
		});

		expect(readSink(volume, "/tmp/results.json")).toBe(
			JSON.stringify(makeJestResult(), null, 2),
		);
	});

	it("should print typecheck-only when typecheckResult is present and runtime is undefined", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		const spies = setupOutputSpies();

		await outputOneProjectAsync({
			config: makeOutputConfig(),
			dependencies,
			result: makeSingleResult({
				runtimeResult: undefined,
				typecheckResult: makeJestResult(),
			}),
		});

		expect(spies.stdout).toHaveBeenCalledWith(expect.stringContaining("Type Errors"));
	});

	it("should print final PASS status when coverage enabled and passed", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		const spies = setupOutputSpies();

		await outputOneProjectAsync({
			config: makeOutputConfig({ collectCoverage: true }),
			dependencies,
			result: makeSingleResult(),
		});

		expect(spies.stdout).toHaveBeenCalledWith(expect.stringContaining("PASS"));
	});

	it("should print final FAIL status when coverage enabled and failed", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		const spies = setupOutputSpies();

		await outputOneProjectAsync({
			config: makeOutputConfig({ collectCoverage: true }),
			dependencies,
			result: makeSingleResult({
				runtimeResult: makeExecuteResult({ result: makeJestResult({ success: false }) }),
			}),
		});

		expect(spies.stdout).toHaveBeenCalledWith(expect.stringContaining("FAIL"));
	});
});

describe(outputMultiResultAsync, () => {
	it("should print formatted multi-project output and return 0 when all succeed", async () => {
		expect.assertions(2);

		const { dependencies } = setupOutput();
		const spies = setupOutputSpies();

		const code = await outputMultiResultAsync({
			dependencies,
			result: makeMultiResult(),
			rootConfig: makeOutputConfig(),
		});

		expect(code).toBe(0);
		expect(spies.consoleLog).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("client"));
	});

	it("should print one gap summary for every project", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		const spies = setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeMultiResult({
				projectResults: [
					{
						displayName: "client",
						result: makeExecuteResult({
							result: makeBlockedResult("src/client.spec.ts", "a"),
						}),
					},
					{
						displayName: "server",
						result: makeExecuteResult({
							result: makeBlockedResult("src/server.spec.ts", "a"),
						}),
					},
				],
			}),
			rootConfig: makeOutputConfig(),
		});

		expect(spies.consoleError).toHaveBeenCalledWith(
			[
				"Blocked (2):",
				"  src/client.spec.ts > a",
				"    script  1 raise",
				"  src/server.spec.ts > a",
				"    script  1 raise",
			].join("\n"),
		);
	});

	it("should return 1 when any project result fails", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		setupOutputSpies();

		const code = await outputMultiResultAsync({
			dependencies,
			result: makeMultiResult({
				projectResults: [
					{
						displayName: "client",
						result: makeExecuteResult({ result: makeJestResult({ success: false }) }),
					},
				],
			}),
			rootConfig: makeOutputConfig(),
		});

		expect(code).toBe(1);
	});

	it("should return 1 when any project had snapshot write failures", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		setupOutputSpies();

		const code = await outputMultiResultAsync({
			dependencies,
			result: makeMultiResult({
				projectResults: [
					{
						displayName: "client",
						result: makeExecuteResult({ snapshotWriteFailures: 1 }),
					},
					{
						displayName: "server",
						result: makeExecuteResult(),
					},
				],
			}),
			rootConfig: makeOutputConfig(),
		});

		expect(code).toBe(1);
	});

	it("should return 1 when any project had obsolete snapshots", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		setupOutputSpies();

		const code = await outputMultiResultAsync({
			dependencies,
			result: makeMultiResult({
				projectResults: [
					{
						displayName: "client",
						result: makeExecuteResult({
							result: makeJestResult({
								snapshot: {
									added: 0,
									matched: 0,
									total: 0,
									unchecked: 1,
									unmatched: 0,
									updated: 0,
								},
							}),
						}),
					},
					{
						displayName: "server",
						result: makeExecuteResult(),
					},
				],
			}),
			rootConfig: makeOutputConfig(),
		});

		expect(code).toBe(1);
	});

	it("should suppress output when config.silent is true", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		const spies = setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeMultiResult(),
			rootConfig: makeOutputConfig({ silent: true }),
		});

		expect(spies.consoleLog).not.toHaveBeenCalled();
	});

	it("should write JSON output when config.outputFile is set", async () => {
		expect.assertions(1);

		const { dependencies, volume } = setupOutput();
		setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeMultiResult(),
			rootConfig: makeOutputConfig({ outputFile: "/tmp/results.json" }),
		});

		expect(readSink(volume, "/tmp/results.json")).toBe(
			JSON.stringify(makeJestResult(), null, 2),
		);
	});

	it("should NOT write the result file for workspace results (the runner handles it)", async () => {
		expect.assertions(1);

		const { dependencies, volume } = setupOutput();
		setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeWorkspaceResult(),
			rootConfig: makeOutputConfig({ outputFile: "/tmp/results.json" }),
		});

		expect(hasSink(volume, "/tmp/results.json")).toBeFalse();
	});

	it("should write a grouped aggregated game output file for multi results when config.gameOutput is set", async () => {
		expect.assertions(1);

		const { dependencies, volume } = setupOutput();
		setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeMultiResult({
				projectResults: [makeProjectResult("client", { gameOutput: RAW_GAME_OUTPUT })],
			}),
			rootConfig: makeOutputConfig({ gameOutput: "/tmp/game.json" }),
		});

		expect(readSink(volume, "/tmp/game.json")).toBe(
			JSON.stringify([{ entries: [GAME_OUTPUT_ENTRY], project: "client" }], null, 2),
		);
	});

	it("should keep per-project groups when a vm-parallel request fell back to sequential", async () => {
		expect.assertions(1);

		const { dependencies, volume } = setupOutput();
		setupOutputSpies();

		// The plugin runs the sequential path when no VM host is ready, and
		// says so by not marking the capture batch-scoped. Each result then
		// carries its own log, which one batch group would throw away.
		await outputMultiResultAsync({
			dependencies,
			result: makeMultiResult({
				projectResults: [
					makeProjectResult("client", { gameOutput: RAW_GAME_OUTPUT }),
					makeProjectResult("server"),
				],
			}),
			rootConfig: makeOutputConfig({
				experimentalVmParallel: 2,
				gameOutput: "/tmp/game.json",
			}),
		});

		expect(readSink(volume, "/tmp/game.json")).toBe(
			JSON.stringify(
				[
					{ entries: [GAME_OUTPUT_ENTRY], project: "client" },
					{ entries: [], project: "server" },
				],
				null,
				2,
			),
		);
	});

	it("should write one batch-scoped game output group for a vm-parallel run", async () => {
		expect.assertions(1);

		const { dependencies, volume } = setupOutput();
		setupOutputSpies();

		// `gameOutputScope` is the runner's own report of what it did: the
		// coordinator sets it only on the path where the hosts actually ran.
		await outputMultiResultAsync({
			dependencies,
			result: makeMultiResult({
				projectResults: [
					makeProjectResult("client", {
						gameOutput: RAW_GAME_OUTPUT,
						gameOutputScope: "batch",
					}),
					makeProjectResult("server", { gameOutputScope: "batch" }),
				],
			}),
			rootConfig: makeOutputConfig({
				experimentalVmParallel: 2,
				gameOutput: "/tmp/game.json",
			}),
		});

		expect(readSink(volume, "/tmp/game.json")).toBe(
			JSON.stringify(
				[
					{
						entries: [GAME_OUTPUT_ENTRY],
						project: "(all projects)",
						scope: "batch",
					},
				],
				null,
				2,
			),
		);
	});

	it("should keep per-project game output groups when the VM request collapses to one", async () => {
		expect.assertions(1);

		const { dependencies, volume } = setupOutput();
		setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeMultiResult({
				projectResults: [makeProjectResult("client"), makeProjectResult("server")],
			}),
			rootConfig: makeOutputConfig({
				experimentalVmParallel: 1,
				gameOutput: "/tmp/game.json",
			}),
		});

		expect(readSink(volume, "/tmp/game.json")).toBe(
			JSON.stringify(
				[
					{ entries: [], project: "client" },
					{ entries: [], project: "server" },
				],
				null,
				2,
			),
		);
	});

	it("should NOT write aggregated game output for workspace results (the runner handles it)", async () => {
		expect.assertions(1);

		const { dependencies, volume } = setupOutput();
		setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeWorkspaceResult(),
			rootConfig: makeOutputConfig({ gameOutput: "/tmp/game.json" }),
		});

		expect(hasSink(volume, "/tmp/game.json")).toBeFalse();
	});

	it("should fall back to outputSingleResult when no project results but typecheck present", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		const spies = setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeMultiResult({
				projectResults: [],
				typecheckResult: makeJestResult(),
			}),
			rootConfig: makeOutputConfig(),
		});

		expect(spies.stdout).toHaveBeenCalledWith(expect.stringContaining("Type Errors"));
	});

	it("should use agent formatter when configured", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		const spies = setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeMultiResult(),
			rootConfig: makeOutputConfig({ formatters: ["agent"] }),
		});

		expect(spies.consoleLog).toHaveBeenCalledWith(expect.stringContaining("client"));
	});

	it("should use json formatter when configured", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		const spies = setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeMultiResult(),
			rootConfig: makeOutputConfig({ formatters: ["json"] }),
		});

		expect(JSON.parse(String(spies.consoleLog.mock.calls[0]![0]))).toStrictEqual(makeJestResult());
	});

	it("should print the type summary to stderr for a non-default formatter when typecheck present", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		const spies = setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeMultiResult({ typecheckResult: makeJestResult() }),
			rootConfig: makeOutputConfig({ formatters: ["json"] }),
		});

		expect(spies.stderr).toHaveBeenCalledWith(expect.stringContaining("Type Errors"));
	});

	it("should print type failures without repeating the row for the agent formatter", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		const spies = setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeMultiResult({
				typecheckResult: makeJestResult({ numFailedTests: 2, success: false }),
			}),
			rootConfig: makeOutputConfig({ formatters: ["agent"] }),
		});

		expect(spies.stderr).toHaveBeenCalledWith(expect.not.stringContaining("Type Errors"));
	});

	it("should accept a workspace result", async () => {
		expect.assertions(2);

		const { dependencies } = setupOutput();
		const spies = setupOutputSpies();

		const code = await outputMultiResultAsync({
			dependencies,
			result: makeWorkspaceResult(),
			rootConfig: makeOutputConfig(),
		});

		expect(code).toBe(0);
		expect(spies.consoleLog).toHaveBeenCalledWith(expect.stringContaining("@halcyon/foo"));
	});

	it("should forward the result's coverage display filter to the reporter", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		setupOutputSpies();

		function displayFilter(): boolean {
			return true;
		}

		await outputMultiResultAsync({
			dependencies,
			result: makeMultiResult({
				coverage: { units: [makeCoverageGate()] },
				coverageDisplayFilter: displayFilter,
				projectResults: [
					{
						displayName: "client",
						result: makeExecuteResult({ coverageData: fromAny({ "x.luau": {} }) }),
					},
				],
			}),
			rootConfig: makeOutputConfig({ collectCoverage: true }),
		});

		expect(pipeline.generateReports).toHaveBeenCalledWith(
			expect.objectContaining({ agentTextFilter: displayFilter }),
		);
	});
});

describe("per-package coverage reports via outputMultiResult", () => {
	it("should generate reports for per-pkg opt-in even when workspace collectCoverage is false", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		setupOutputSpies();

		const fooUniverse: MappedCoverageResult = fromAny({ files: { "foo.ts": {} } });
		await outputMultiResultAsync({
			dependencies,
			result: makeWorkspaceResult({
				coverage: { units: [makeCoverageGate({ universe: fooUniverse })] },
			}),
			rootConfig: makeOutputConfig(),
		});

		expect(pipeline.generateReports).toHaveBeenCalledWith(
			expect.objectContaining({ mapped: fooUniverse }),
		);
	});

	it("should suppress package coverage labels when workspace output is silent", async () => {
		expect.assertions(2);

		const { dependencies } = setupOutput();
		const spies = setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeWorkspaceResult({
				coverage: { units: [makeCoverageGate()] },
				output: makeReportOptions({ silent: true }),
			}),
			rootConfig: makeOutputConfig(),
		});

		expect(spies.stdout).not.toHaveBeenCalled();
		expect(pipeline.generateReports).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				coverageDirectory: "/workspace/packages/foo/coverage",
				reporters: ["text", "lcov"],
			}),
		);
	});

	it("should emit one report per package, each into its own directory with its own reporters", async () => {
		expect.assertions(3);

		const { dependencies } = setupOutput();
		setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeWorkspaceResult({
				coverage: { units: [
					makeCoverageGate({
						coverageDirectory: "/ws/packages/foo/coverage",
						reporters: ["text"],
					}),
					makeCoverageGate({
						coverageDirectory: "/ws/packages/bar/cov",
						reporters: ["lcov"],
						label: "@halcyon/bar",
					}),
				] },
			}),
			rootConfig: makeOutputConfig(),
		});

		expect(pipeline.generateReports).toHaveBeenCalledTimes(2);
		expect(pipeline.generateReports).toHaveBeenCalledWith(
			expect.objectContaining({
				coverageDirectory: "/ws/packages/foo/coverage",
				reporters: ["text"],
			}),
		);
		expect(pipeline.generateReports).toHaveBeenCalledWith(
			expect.objectContaining({
				coverageDirectory: "/ws/packages/bar/cov",
				reporters: ["lcov"],
			}),
		);
	});

	it("should head each package report with the package name", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		const spies = setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeWorkspaceResult({ coverage: { units: [makeCoverageGate()] } }),
			rootConfig: makeOutputConfig(),
		});

		expect(spies.stdout).toHaveBeenCalledWith("\n@halcyon/foo\n");
	});

	it("should emit no report and no header when no package produced coverage", async () => {
		expect.assertions(2);

		const { dependencies } = setupOutput();
		const spies = setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeWorkspaceResult({ coverage: { units: [] } }),
			rootConfig: makeOutputConfig({ collectCoverage: true }),
		});

		expect(spies.stdout).not.toHaveBeenCalledWith(expect.stringContaining(COVERAGE_HEADER));
		expect(pipeline.generateReports).not.toHaveBeenCalled();
	});

	it("should enforce a package's own threshold when workspace collectCoverage is false", async () => {
		expect.assertions(2);

		const { dependencies } = setupOutput();
		pipeline.checkThresholds.mockReturnValue({
			failures: [{ actual: 50, metric: "lines", threshold: 100 }],
			passed: false,
		});
		const spies = setupOutputSpies();

		const code = await outputMultiResultAsync({
			dependencies,
			result: makeWorkspaceResult({
				coverage: { units: [makeCoverageGate({ coverageThreshold: { lines: 100 } })] },
			}),
			rootConfig: makeOutputConfig(),
		});

		expect(code).toBe(1);
		expect(spies.stderr).toHaveBeenCalledWith(
			expect.stringContaining("Coverage threshold not met"),
		);
	});
});

describe("per-package threshold gates via outputMultiResult", () => {
	it("should gate each package against its own universe and its own threshold", async () => {
		expect.assertions(2);

		const { dependencies } = setupOutput();
		setupOutputSpies();

		const fooUniverse: MappedCoverageResult = fromAny({ files: { "foo.ts": {} } });
		const code = await outputMultiResultAsync({
			dependencies,
			result: makeWorkspaceResult({
				coverage: { units: [
					makeCoverageGate({ coverageThreshold: { lines: 70 }, universe: fooUniverse }),
				] },
			}),
			rootConfig: makeOutputConfig(),
		});

		// One call only: the pooled merged-universe check is replaced by the
		// per-package gates.
		expect(pipeline.checkThresholds).toHaveBeenCalledExactlyOnceWith({
			mapped: fooUniverse,
			thresholds: { lines: 70 },
		});
		expect(code).toBe(0);
	});

	it("should gate only the metrics the package itself declared", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		setupOutputSpies();

		const fooUniverse: MappedCoverageResult = fromAny({ files: { "foo.ts": {} } });
		await outputMultiResultAsync({
			dependencies,
			result: makeWorkspaceResult({
				coverage: { units: [
					makeCoverageGate({
						coverageThreshold: { statements: 70 },
						universe: fooUniverse,
					}),
				] },
			}),
			rootConfig: makeOutputConfig(),
		});

		expect(pipeline.checkThresholds).toHaveBeenCalledWith({
			mapped: fooUniverse,
			thresholds: { statements: 70 },
		});
	});

	it("should not gate a package that declared no threshold", async () => {
		expect.assertions(2);

		const { dependencies } = setupOutput();
		setupOutputSpies();

		const code = await outputMultiResultAsync({
			dependencies,
			result: makeWorkspaceResult({ coverage: { units: [makeCoverageGate()] } }),
			rootConfig: makeOutputConfig(),
		});

		expect(pipeline.checkThresholds).not.toHaveBeenCalled();
		expect(code).toBe(0);
	});

	it("should print package-prefixed failures and exit 1 when a package misses its threshold", async () => {
		expect.assertions(2);

		const { dependencies } = setupOutput();
		pipeline.checkThresholds
			.mockReturnValueOnce({ failures: [], passed: true })
			.mockReturnValueOnce({
				failures: [{ actual: 75, metric: "lines", threshold: 80 }],
				passed: false,
			});
		const spies = setupOutputSpies();

		const code = await outputMultiResultAsync({
			dependencies,
			result: makeWorkspaceResult({
				coverage: { units: [
					makeCoverageGate({ coverageThreshold: { lines: 70 } }),
					makeCoverageGate({ coverageThreshold: { lines: 80 }, label: "@halcyon/bar" }),
				] },
			}),
			rootConfig: makeOutputConfig(),
		});

		expect(code).toBe(1);
		expect(spies.stderr).toHaveBeenCalledWith(
			"Coverage threshold not met for @halcyon/bar lines: 75.00% < 80%\n",
		);
	});
});

// `GITHUB_WORKSPACE` is set on CI and rewrites an annotation's `file=` path.
const FAILURE_ANNOTATION = "title=player explodes::boom\n";

describe("runGitHubActionsFormatter via a one-project run", () => {
	it("should be a no-op when formatter not configured", async () => {
		expect.assertions(2);

		const { dependencies, volume } = setupOutput();
		const spies = setupOutputSpies();
		process.env["GITHUB_STEP_SUMMARY"] = "/tmp/summary.md";
		volume.mkdirSync("/tmp", { recursive: true });

		await outputOneProjectAsync({
			config: makeOutputConfig(),
			dependencies,
			result: makeSingleResult({
				runtimeResult: makeExecuteResult({ result: makeFailingResult() }),
			}),
		});

		expect(spies.stderr).not.toHaveBeenCalled();
		expect(volume.existsSync("/tmp/summary.md")).toBeFalse();
	});

	it("should write annotations to stderr", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		const spies = setupOutputSpies();

		await outputOneProjectAsync({
			config: makeOutputConfig({ formatters: ["default", "github-actions"] }),
			dependencies,
			result: makeSingleResult({
				runtimeResult: makeExecuteResult({ result: makeFailingResult() }),
			}),
		});

		expect(spies.stderr).toHaveBeenCalledWith(expect.stringContaining(FAILURE_ANNOTATION));
	});

	it("should run the GitHub Actions formatter for multi-project results", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		const spies = setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeMultiResult({
				projectResults: [makeProjectResult("client", { result: makeFailingResult() })],
			}),
			rootConfig: makeOutputConfig({ formatters: ["default", "github-actions"] }),
		});

		expect(spies.stderr).toHaveBeenCalledWith(expect.stringContaining(FAILURE_ANNOTATION));
	});

	it("should skip annotations when displayAnnotations is false", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		const spies = setupOutputSpies();

		await outputOneProjectAsync({
			config: makeOutputConfig({
				formatters: ["default", ["github-actions", { displayAnnotations: false }]],
			}),
			dependencies,
			result: makeSingleResult({
				runtimeResult: makeExecuteResult({ result: makeFailingResult() }),
			}),
		});

		expect(spies.stderr).not.toHaveBeenCalledWith(expect.stringContaining("::error"));
	});

	it("should skip annotations when content is empty string", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		const spies = setupOutputSpies();

		await outputOneProjectAsync({
			config: makeOutputConfig({ formatters: ["default", "github-actions"] }),
			dependencies,
			result: makeSingleResult(),
		});

		expect(spies.stderr).not.toHaveBeenCalled();
	});

	it("should write job summary to GITHUB_STEP_SUMMARY env path", async () => {
		expect.assertions(1);

		const { dependencies, volume } = setupOutput();

		setupOutputSpies();
		process.env["GITHUB_STEP_SUMMARY"] = "/tmp/summary.md";
		volume.mkdirSync("/tmp", { recursive: true });

		await outputOneProjectAsync({
			config: makeOutputConfig({ formatters: ["default", "github-actions"] }),
			dependencies,
			result: makeSingleResult(),
		});

		expect(volume.readFileSync("/tmp/summary.md", "utf8")).toContain("## Test Results");
	});

	it("should write job summary to explicit outputPath", async () => {
		expect.assertions(1);

		const { dependencies, volume } = setupOutput();

		volume.mkdirSync("/tmp", { recursive: true });

		setupOutputSpies();

		await outputOneProjectAsync({
			config: makeOutputConfig({
				formatters: [
					"default",
					["github-actions", { jobSummary: { outputPath: "/tmp/explicit.md" } }],
				],
			}),
			dependencies,
			result: makeSingleResult(),
		});

		expect(volume.readFileSync("/tmp/explicit.md", "utf8")).toContain("## Test Results");
	});

	it("should skip job summary when jobSummary.enabled is false", async () => {
		expect.assertions(1);

		const { dependencies, volume } = setupOutput();
		setupOutputSpies();
		process.env["GITHUB_STEP_SUMMARY"] = "/tmp/summary.md";
		volume.mkdirSync("/tmp", { recursive: true });

		await outputOneProjectAsync({
			config: makeOutputConfig({
				formatters: ["default", ["github-actions", { jobSummary: { enabled: false } }]],
			}),
			dependencies,
			result: makeSingleResult(),
		});

		expect(volume.existsSync("/tmp/summary.md")).toBeFalse();
	});

	it("should skip job summary when no outputPath available", async () => {
		expect.assertions(1);

		const { dependencies, volume } = setupOutput();
		setupOutputSpies();

		await outputOneProjectAsync({
			config: makeOutputConfig({ formatters: ["default", "github-actions"] }),
			dependencies,
			result: makeSingleResult(),
		});

		expect(volume.toJSON()).toStrictEqual({});
	});
});

describe("writeGameOutput integration", () => {
	it("should print aggregated notice for multi-project mode", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		const spies = setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeMultiResult({
				projectResults: [makeProjectResult("client", { gameOutput: RAW_GAME_OUTPUT })],
			}),
			rootConfig: makeOutputConfig({ gameOutput: "/tmp/game.json" }),
		});

		expect(spies.consoleError).toHaveBeenCalledExactlyOnceWith(
			"Game output (1 entries) written to /tmp/game.json",
		);
	});

	it("should suppress aggregated notice on failure", async () => {
		expect.assertions(2);

		const { dependencies, volume } = setupOutput();
		const spies = setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeMultiResult({
				projectResults: [
					{
						displayName: "client",
						result: makeExecuteResult({
							gameOutput: RAW_GAME_OUTPUT,
							result: makeJestResult({ success: false }),
						}),
					},
				],
			}),
			rootConfig: makeOutputConfig({ gameOutput: "/tmp/game.json" }),
		});

		expect(hasSink(volume, "/tmp/game.json")).toBeTrue();
		expect(spies.consoleError).not.toHaveBeenCalled();
	});

	it("should suppress aggregated notice when empty", async () => {
		expect.assertions(2);

		const { dependencies, volume } = setupOutput();
		const spies = setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeMultiResult(),
			rootConfig: makeOutputConfig({ gameOutput: "/tmp/game.json" }),
		});

		expect(readSink(volume, "/tmp/game.json")).toBe(
			JSON.stringify([{ entries: [], project: "client" }], null, 2),
		);
		expect(spies.consoleError).not.toHaveBeenCalled();
	});
});

describe("result file sink", () => {
	// Single AND multi serialize *exactly* the shared `mergeResults` output, so a
	// new result dimension reaches the file in every mode by a one-line change to
	// that merge — no per-writer / per-branch hunt. (The workspace mode's
	// identical guarantee is asserted in `workspace-runner.spec.ts` against the
	// real on-disk file.)

	it("should write exactly the shared mergeResults output for multi mode", async () => {
		expect.assertions(1);

		const { dependencies, volume } = setupOutput();
		setupOutputSpies();

		const typecheckResult = makeJestResult({ numFailedTests: 1, success: false });
		const runtime = makeJestResult({ numPassedTests: 3, numTotalTests: 3 });

		await outputMultiResultAsync({
			dependencies,
			result: makeMultiResult({
				projectResults: [makeProjectResult("client", { result: runtime })],
				typecheckResult,
			}),
			rootConfig: makeOutputConfig({ outputFile: "/tmp/results.json" }),
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

describe("merged typecheck + runtime branches", () => {
	it("should default numTodoTests to 0 when typecheck and runtime both lack it", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		setupOutputSpies();

		const code = await outputOneProjectAsync({
			config: makeOutputConfig(),
			dependencies,
			result: makeSingleResult({
				runtimeResult: makeExecuteResult({
					result: { ...makeJestResult(), numTodoTests: undefined },
				}),
				typecheckResult: { ...makeJestResult(), numTodoTests: undefined },
			}),
		});

		expect(code).toBe(0);
	});
});

function passingTest(index: number): TestCaseResult {
	return {
		ancestorTitles: ["inventory"],
		duration: 1,
		failureMessages: [],
		fullName: `inventory case ${index}`,
		status: "passed",
		title: `case ${index}`,
	};
}

function passingResult(): JestResult {
	return {
		numFailedTests: 0,
		numPassedTests: 5,
		numPendingTests: 0,
		numTodoTests: 0,
		numTotalTests: 5,
		startTime: 1000,
		success: true,
		testResults: [
			{
				numFailingTests: 0,
				numPassingTests: 5,
				numPendingTests: 0,
				testFilePath: "src/client/inventory.spec.ts",
				testResults: [0, 1, 2, 3, 4].map(passingTest),
			},
		],
	};
}

/**
 * One file fully covered (hidden by skipFull), one partial (shown), so the agent
 * table and the raw-counts totals line both have something to print.
 * @returns The mapped coverage.
 */
function mixedCoverage(): MappedCoverageResult {
	return {
		files: {
			"src/client/inventory.ts": mappedFile({
				f: { "0": 5 },
				path: "src/client/inventory.ts",
				s: { "0": 5, "1": 2, "2": 3 },
			}),
			"src/client/player.ts": mappedFile({ path: "src/client/player.ts" }),
		},
	};
}

function makeCoverageWorkspaceResult(): RunResult {
	return fromAny({
		coverageMs: 0,
		coverage: { units: [
			{
				coverageDirectory: "/test/coverage",
				label: "client",
				reporters: ["text"],
				universe: mixedCoverage(),
			},
		] },
		projectResults: [
			{
				displayName: "client",
				result: {
					exitCode: 0,
					output: "",
					result: passingResult(),
					timing: { executionMs: 50, startTime: 1000, testsMs: 30, totalMs: 100 },
				},
			},
		],
		output: {
			collectCoverage: true,
			color: false,
			formatters: ["agent"],
			perUnitGameOutput: false,
			perUnitOutputFile: false,
			rootDir: "/test",
			showLuau: true,
			silent: false,
			verbose: false,
		},
		stagingMs: 0,
	});
}

describe("agent-mode output ordering", () => {
	it("should render the run summary after the coverage report and above the status line", async () => {
		expect.assertions(1);

		const chunks: Array<string> = [];
		vi.spyOn(console, "log").mockImplementation((message) => {
			chunks.push(`${String(message)}\n`);
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			chunks.push(String(chunk));
			return true;
		});
		vi.spyOn(process.stderr, "write").mockReturnValue(true);

		await outputRunAsync({ result: makeCoverageWorkspaceResult() });

		expect(stripVTControlCharacters(chunks.join(""))).toMatchInlineSnapshot(`
			"
			 % Coverage report from istanbul

			client
			--------------|---------|----------|---------|---------|-------------------
			File          | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s 
			--------------|---------|----------|---------|---------|-------------------
			All files     |   83.33 |      100 |     100 |   83.33 |                   
			 player.ts    |   66.66 |      100 |     100 |   66.66 | 3                 
			--------------|---------|----------|---------|---------|-------------------
			Coverage: 83.33% stmts (5/6) | 100% branch (0/0) | 100% funcs (2/2) | 83.33% lines (5/6)
			▶ client  1 passed (5 tests)
			 Test Files  1 passed (1)
			      Tests  5 passed (5)
			 PASS 
			"
		`);
	});
});

function setupReport() {
	const coveragePipeline = {
		checkThresholds: vi
			.fn<typeof checkThresholds>()
			.mockReturnValue({ failures: [], passed: true }),
		generateReports: vi.fn<typeof generateReports>(),
	};
	const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(process.stdout, "write").mockReturnValue(true);
	vi.spyOn(process.stderr, "write").mockReturnValue(true);
	const { fileSystem } = createMemoryFileSystem();

	return {
		consoleLog,
		coveragePipeline,
		dependencies: { coveragePipeline, fileSystem },
	};
}

type ReportHarness = ReturnType<typeof setupReport>;

function makeReportSettings(overrides: Partial<OutputSettings> = {}): OutputSettings {
	return {
		collectCoverage: true,
		color: false,
		formatters: ["agent"],
		perUnitGameOutput: false,
		perUnitOutputFile: false,
		rootDir: "/repo",
		showLuau: true,
		silent: false,
		verbose: false,
		...overrides,
	};
}

async function reportAsync(harness: ReportHarness, settings: OutputSettings): Promise<number> {
	const runtime = makeExecuteResult();
	const result: RunResult = {
		coverage: {
			units: [
				{ coverageDirectory: "/repo/coverage", reporters: ["text"], universe: fromAny({}) },
			],
		},
		coverageMs: 0,
		output: settings,
		projectResults: [{ displayName: "client", result: runtime }],
		stagingMs: 0,
	};

	return outputRunAsync({ dependencies: harness.dependencies, result });
}

function isCoverageFirst(harness: ReportHarness): boolean {
	const coverageOrder = harness.coveragePipeline.generateReports.mock.invocationCallOrder[0]!;
	const summaryOrder = harness.consoleLog.mock.invocationCallOrder[0]!;

	return coverageOrder < summaryOrder;
}

describe("outputRunAsync report order", () => {
	it("should print coverage before the agent summary so trimming keeps it", async () => {
		expect.assertions(2);

		const harness = setupReport();

		await expect(reportAsync(harness, makeReportSettings())).resolves.toBe(0);
		expect(isCoverageFirst(harness)).toBeTrue();
	});

	it("should keep the summary before coverage for the default formatter", async () => {
		expect.assertions(1);

		const harness = setupReport();
		await reportAsync(harness, makeReportSettings({ formatters: ["default"] }));

		expect(isCoverageFirst(harness)).toBeFalse();
	});

	it("should keep the summary before coverage when verbose opts out of the agent formatter", async () => {
		expect.assertions(1);

		const harness = setupReport();
		await reportAsync(harness, makeReportSettings({ verbose: true }));

		expect(isCoverageFirst(harness)).toBeFalse();
	});

	it("should keep the agent summary inline when coverage is disabled", async () => {
		expect.assertions(1);

		const harness = setupReport();
		await reportAsync(harness, makeReportSettings({ collectCoverage: false }));

		expect(isCoverageFirst(harness)).toBeFalse();
	});

	it("should still print the deferred agent summary when the coverage report throws", async () => {
		expect.assertions(2);

		const harness = setupReport();
		harness.coveragePipeline.generateReports.mockImplementation(() => {
			throw new Error("malformed coverage map");
		});

		await expect(reportAsync(harness, makeReportSettings())).rejects.toThrow(
			"malformed coverage map",
		);
		expect(harness.consoleLog).toHaveBeenCalledWith(expect.stringContaining("client"));
	});
});
