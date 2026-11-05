import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import process from "node:process";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { createMemoryFileSystem, type MemoryVolume } from "#test/mocks/memory-file-system.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import { mappedFile } from "#test/mocks/spec-coverage.ts";
import {
	makeBlockedResult,
	makeExecuteResult,
	makeJestResult,
	makeOutputConfig,
	setupOutputSpies,
} from "#test/mocks/spec-results.ts";
import type { ResolvedConfig } from "./config/schema.ts";
import type { loadCoverageManifest } from "./coverage-pipeline/manifest-load.ts";
import type { MappedCoverageResult } from "./coverage-pipeline/mapper-types.ts";
import type { mapCoverageToTypeScript } from "./coverage-pipeline/mapper.ts";
import type { checkThresholds, generateReports } from "./coverage-pipeline/reporter.ts";
import type { formatExecuteOutput } from "./executor/format-output.ts";
import type { formatAgentMultiProject } from "./formatters/agent.ts";
import type {
	formatMultiProjectResult,
	formatResult,
	formatTypecheckReport,
} from "./formatters/formatter.ts";
import { outputMultiResultAsync } from "./output.ts";
import type {
	MultiRunResult,
	ProjectResult,
	SingleRunResult,
	WorkspacePackageCoverageGate,
	WorkspaceReportOptions,
	WorkspaceRunResult,
} from "./run/run-types.ts";
import type { GameOutputEntry } from "./types/game-output-types.ts";
import type { JestResult, TestCaseResult } from "./types/jest-result-types.ts";
import type { FileSystem } from "./utils/file-system.ts";

type OutputDependencies = NonNullable<Parameters<typeof outputMultiResultAsync>[0]["dependencies"]>;

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
	loadCoverageManifest: vi.fn<typeof loadCoverageManifest>(),
	mapCoverageToTypeScript: vi.fn<typeof mapCoverageToTypeScript>(),
};

const renderer = {
	formatAgentMultiProject: vi.fn<typeof formatAgentMultiProject>(),
	formatExecuteOutput: vi.fn<typeof formatExecuteOutput>(),
	formatMultiProjectResult: vi.fn<typeof formatMultiProjectResult>(),
	formatResult: vi.fn<typeof formatResult>(),
	formatTypecheckReport: vi.fn<typeof formatTypecheckReport>(),
};

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

function makeSingleResult(overrides: Partial<SingleRunResult> = {}): SingleRunResult {
	return {
		coverageMs: 0,
		mode: "single",
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

function makeMultiResult(overrides: Partial<MultiRunResult> = {}): MultiRunResult {
	return {
		coverageMs: 0,
		merged: {},
		mode: "multi",
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
	result: SingleRunResult;
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

function makeReportOptions(
	overrides: Partial<WorkspaceReportOptions> = {},
): WorkspaceReportOptions {
	return {
		color: true,
		formatters: ["default"],
		rootDir: "/workspace",
		silent: false,
		verbose: false,
		...overrides,
	};
}

function makeCoverageGate(
	overrides: Partial<WorkspacePackageCoverageGate> = {},
): WorkspacePackageCoverageGate {
	return {
		coverageDirectory: "/workspace/packages/foo/coverage",
		coverageReporters: ["text", "lcov"],
		pkg: "@halcyon/foo",
		universe: fromAny({ files: { "foo.ts": {} } }),
		...overrides,
	};
}

function makeWorkspaceResult(overrides: Partial<WorkspaceRunResult> = {}): WorkspaceRunResult {
	return {
		coverageMs: 0,
		merged: {},
		mode: "workspace",
		projectResults: [makeProjectResult("@halcyon/foo")],
		reportOptions: makeReportOptions(),
		stagingMs: 0,
		...overrides,
	};
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

	renderer.formatResult.mockReturnValue("formatted-result");
	renderer.formatMultiProjectResult.mockReturnValue("formatted-multi");
	renderer.formatAgentMultiProject.mockReturnValue("formatted-agent");
	renderer.formatExecuteOutput.mockReturnValue("formatted-execute");
	renderer.formatTypecheckReport.mockReturnValue("typecheck-summary");
	pipeline.loadCoverageManifest.mockReturnValue(undefined);
	pipeline.checkThresholds.mockReturnValue({ failures: [], passed: true });

	const { fileSystem, volume } = createMemoryFileSystem();

	return {
		dependencies: { coveragePipeline: pipeline, fileSystem, renderer },
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

	it("should propagate a workspace bail summary to the agent formatter", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeWorkspaceResult({
				bail: { notRun: 2, ran: 1 },
				reportOptions: { ...makeReportOptions(), formatters: ["agent"] },
			}),
			rootConfig: makeOutputConfig({ formatters: ["agent"] }),
		});

		expect(renderer.formatAgentMultiProject).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ bail: { notRun: 2, ran: 1 } }),
		);
	});

	it("should fold workspace staging time into the reported timing", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeWorkspaceResult({ stagingMs: 400 }),
			rootConfig: makeOutputConfig(),
		});

		expect(renderer.formatMultiProjectResult).toHaveBeenCalledWith(
			expect.objectContaining({
				timing: expect.objectContaining({ coverageMs: 0, stagingMs: 400, totalMs: 600 }),
			}),
		);
	});

	it("should report staging and coverage as separate phases", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeMultiResult({ coverageMs: 120, stagingMs: 300 }),
			rootConfig: makeOutputConfig(),
		});

		expect(renderer.formatMultiProjectResult).toHaveBeenCalledWith(
			expect.objectContaining({
				timing: expect.objectContaining({ coverageMs: 120, stagingMs: 300, totalMs: 620 }),
			}),
		);
	});

	it("should propagate a workspace bail summary to the multi formatter", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeWorkspaceResult({ bail: { notRun: 2, ran: 1 } }),
			rootConfig: makeOutputConfig(),
		});

		expect(renderer.formatMultiProjectResult).toHaveBeenCalledWith(
			expect.objectContaining({
				options: expect.objectContaining({ bail: { notRun: 2, ran: 1 } }),
			}),
		);
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

		expect(spies.stdout).toHaveBeenCalledWith("typecheck-summary");
	});

	it.for([false, true])("should render typecheck-only with color=%s", async (color) => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		setupOutputSpies();

		await outputOneProjectAsync({
			config: makeOutputConfig({ color }),
			dependencies,
			result: makeSingleResult({
				runtimeResult: undefined,
				typecheckResult: makeJestResult(),
			}),
		});

		expect(renderer.formatTypecheckReport).toHaveBeenCalledWith(expect.anything(), {
			useColor: color,
		});
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
		expect.assertions(3);

		const { dependencies } = setupOutput();
		const spies = setupOutputSpies();

		const code = await outputMultiResultAsync({
			dependencies,
			result: makeMultiResult(),
			rootConfig: makeOutputConfig(),
		});

		expect(code).toBe(0);
		expect(spies.consoleLog).toHaveBeenCalledWith("formatted-multi");
		expect(renderer.formatMultiProjectResult).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining<Record<string, unknown>>({ projects: expect.any(Array) }),
		);
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

	it("should propagate aggregated snapshotWriteFailures to multi formatter", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeMultiResult({
				projectResults: [
					{
						displayName: "client",
						result: makeExecuteResult({ snapshotWriteFailures: 2 }),
					},
					{
						displayName: "server",
						result: makeExecuteResult({ snapshotWriteFailures: 3 }),
					},
				],
			}),
			rootConfig: makeOutputConfig(),
		});

		expect(renderer.formatMultiProjectResult).toHaveBeenCalledWith(
			expect.objectContaining({
				options: expect.objectContaining({ snapshotWriteFailures: 5 }),
			}),
		);
	});

	it("should hand each project its own raw game output to the multi formatter", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeMultiResult({
				projectResults: [
					{
						displayName: "client",
						result: makeExecuteResult({ gameOutput: "client-raw" }),
					},
					{
						displayName: "server",
						result: makeExecuteResult({ gameOutput: "server-raw" }),
					},
				],
			}),
			rootConfig: makeOutputConfig(),
		});

		expect(renderer.formatMultiProjectResult).toHaveBeenCalledWith(
			expect.objectContaining<Record<string, unknown>>({
				projects: [
					expect.objectContaining({ displayName: "client", gameOutput: "client-raw" }),
					expect.objectContaining({ displayName: "server", gameOutput: "server-raw" }),
				],
			}),
		);
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

		expect(spies.stdout).toHaveBeenCalledWith("typecheck-summary");
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

		expect(spies.consoleLog).toHaveBeenCalledWith("formatted-agent");
	});

	it("should use agent formatter with maxFailures option", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeMultiResult(),
			rootConfig: makeOutputConfig({ formatters: [["agent", { maxFailures: 5 }]] }),
		});

		expect(renderer.formatAgentMultiProject).toHaveBeenCalledWith(
			expect.any(Array),
			expect.objectContaining({ maxFailures: 5 }),
		);
	});

	it("should point agent hints at the workspace-resolved sink paths, not config", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeWorkspaceResult({
				gameOutput: "/ws/game-output.log",
				outputFile: "/ws/jest-output.log",
				reportOptions: makeReportOptions({ formatters: ["agent"] }),
			}),
			rootConfig: makeOutputConfig({
				gameOutput: "/root/cfg.log",
				outputFile: "/root/cfg.json",
			}),
		});

		expect(renderer.formatAgentMultiProject).toHaveBeenCalledWith(
			expect.any(Array),
			expect.objectContaining({
				gameOutput: "/ws/game-output.log",
				outputFile: "/ws/jest-output.log",
			}),
		);
	});

	it("should point agent hints at config paths for multi (non-workspace) runs", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeMultiResult(),
			rootConfig: makeOutputConfig({
				formatters: ["agent"],
				gameOutput: "/root/cfg.log",
				outputFile: "/root/cfg.json",
			}),
		});

		expect(renderer.formatAgentMultiProject).toHaveBeenCalledWith(
			expect.any(Array),
			expect.objectContaining({ gameOutput: "/root/cfg.log", outputFile: "/root/cfg.json" }),
		);
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

		expect(spies.consoleLog).toHaveBeenCalledWith("formatted-execute");
	});

	it("should print typecheck-summary to stderr for non-default formatter when typecheck present", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		const spies = setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeMultiResult({ typecheckResult: makeJestResult() }),
			rootConfig: makeOutputConfig({ formatters: ["json"] }),
		});

		expect(spies.stderr).toHaveBeenCalledWith("typecheck-summary");
	});

	it("should print type failures without repeating the row for the agent formatter", async () => {
		expect.assertions(2);

		const { dependencies } = setupOutput();
		const spies = setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeMultiResult({
				typecheckResult: makeJestResult({ numFailedTests: 2, success: false }),
			}),
			rootConfig: makeOutputConfig({ formatters: ["agent"] }),
		});

		expect(spies.stderr).toHaveBeenCalledWith("typecheck-summary");
		expect(renderer.formatTypecheckReport).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ includeSummaryRows: false }),
		);
	});

	it("should write nothing when a clean type pass leaves the agent report empty", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		renderer.formatTypecheckReport.mockReturnValue("");
		const spies = setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeMultiResult({ typecheckResult: makeJestResult() }),
			rootConfig: makeOutputConfig({ formatters: ["agent"] }),
		});

		expect(spies.stderr).not.toHaveBeenCalled();
	});

	it("should apply collectCoverageFrom override from result onto config", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		pipeline.loadCoverageManifest.mockReturnValue(fromAny({}));
		pipeline.mapCoverageToTypeScript.mockReturnValue(fromAny({}));
		setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeMultiResult({
				collectCoverageFrom: ["src/**/*.ts"],
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
			expect.objectContaining({ collectCoverageFrom: ["src/**/*.ts"] }),
		);
	});

	it("should keep the config's collectCoverageFrom when the result narrows nothing", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		pipeline.loadCoverageManifest.mockReturnValue(fromAny({}));
		pipeline.mapCoverageToTypeScript.mockReturnValue(fromAny({}));
		setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeMultiResult({
				projectResults: [
					{
						displayName: "client",
						result: makeExecuteResult({ coverageData: fromAny({ "x.luau": {} }) }),
					},
				],
			}),
			rootConfig: makeOutputConfig({
				collectCoverage: true,
				collectCoverageFrom: ["src/**/*.ts"],
			}),
		});

		expect(pipeline.generateReports).toHaveBeenCalledWith(
			expect.objectContaining({ collectCoverageFrom: ["src/**/*.ts"] }),
		);
	});

	it("should accept WorkspaceRunResult", async () => {
		expect.assertions(2);

		const { dependencies } = setupOutput();
		const spies = setupOutputSpies();

		const code = await outputMultiResultAsync({
			dependencies,
			result: makeWorkspaceResult(),
			rootConfig: makeOutputConfig(),
		});

		expect(code).toBe(0);
		expect(spies.consoleLog).toHaveBeenCalledWith("formatted-multi");
	});

	it("should forward the result's coverage display filter to the reporter", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		pipeline.loadCoverageManifest.mockReturnValue(fromAny({}));
		pipeline.mapCoverageToTypeScript.mockReturnValue(fromAny({}));
		setupOutputSpies();

		function displayFilter(): boolean {
			return true;
		}

		await outputMultiResultAsync({
			dependencies,
			result: makeMultiResult({
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

// Workspace mode reads the config file at cwd for `workspace.root` /
// `workspace.packages` only. Every case below hands `outputMultiResultAsync` a
// hostile bootstrap config whose value differs from the run's resolved one, so
// a leak shows up as the hostile value reaching the report or print layer.
describe("workspace output ignores the bootstrap config", () => {
	it("should render with the runner's formatters, not the bootstrap config's", async () => {
		expect.assertions(2);

		const { dependencies } = setupOutput();
		const spies = setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeWorkspaceResult(),
			rootConfig: makeOutputConfig({ formatters: ["agent"] }),
		});

		expect(spies.consoleLog).toHaveBeenCalledWith("formatted-multi");
		expect(renderer.formatAgentMultiProject).not.toHaveBeenCalled();
	});

	it("should print when the runner resolved silent false and the bootstrap config says true", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		const spies = setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeWorkspaceResult(),
			rootConfig: makeOutputConfig({ silent: true }),
		});

		expect(spies.consoleLog).toHaveBeenCalledWith("formatted-multi");
	});

	it("should report agent paths against the workspace root, not the bootstrap rootDir", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeWorkspaceResult({
				reportOptions: makeReportOptions({ formatters: ["agent"] }),
			}),
			rootConfig: makeOutputConfig({ rootDir: "/bootstrap" }),
		});

		expect(renderer.formatAgentMultiProject).toHaveBeenCalledWith(
			expect.any(Array),
			expect.objectContaining({ rootDir: "/workspace" }),
		);
	});

	it("should not write the bootstrap outputFile on a typecheck-only workspace run", async () => {
		expect.assertions(1);

		const { dependencies, volume } = setupOutput();
		setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeWorkspaceResult({ projectResults: [], typecheckResult: makeJestResult() }),
			rootConfig: makeOutputConfig({ outputFile: "/root/cfg.json" }),
		});

		expect(hasSink(volume, "/root/cfg.json")).toBeFalse();
	});

	it("should not run the GitHub Actions formatter the bootstrap config asked for", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		const spies = setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeWorkspaceResult({
				projectResults: [
					makeProjectResult("@halcyon/foo", { result: makeFailingResult() }),
				],
			}),
			rootConfig: makeOutputConfig({ formatters: ["default", "github-actions"] }),
		});

		expect(spies.stderr).not.toHaveBeenCalledWith(expect.stringContaining("::error"));
	});

	it("should keep the bootstrap coverage settings out of the report", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeWorkspaceResult({ coveragePackages: [makeCoverageGate()] }),
			rootConfig: makeOutputConfig({
				collectCoverage: true,
				collectCoverageFrom: ["src/server/**/ecs/**"],
				coverageDirectory: "bootstrap-coverage",
				coverageReporters: ["cobertura"],
				rootDir: "/bootstrap",
			}),
		});

		expect(pipeline.generateReports).toHaveBeenCalledWith(
			expect.objectContaining({
				collectCoverageFrom: undefined,
				coverageDirectory: "/workspace/packages/foo/coverage",
				reporters: ["text", "lcov"],
			}),
		);
	});

	it("should not gate a workspace package on the bootstrap coverageThreshold", async () => {
		expect.assertions(2);

		const { dependencies } = setupOutput();
		setupOutputSpies();

		const code = await outputMultiResultAsync({
			dependencies,
			result: makeWorkspaceResult({ coveragePackages: [makeCoverageGate()] }),
			rootConfig: makeOutputConfig({
				collectCoverage: true,
				coverageThreshold: { lines: 80 },
			}),
		});

		expect(pipeline.checkThresholds).not.toHaveBeenCalled();
		expect(code).toBe(0);
	});

	it("should not map coverage through the bootstrap rootDir manifest", async () => {
		expect.assertions(2);

		const { dependencies } = setupOutput();
		pipeline.loadCoverageManifest.mockReturnValue(fromAny({}));
		pipeline.mapCoverageToTypeScript.mockReturnValue(fromAny({}));
		setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeWorkspaceResult({
				projectResults: [
					{
						displayName: "@halcyon/foo",
						result: makeExecuteResult({ coverageData: fromAny({ "x.luau": {} }) }),
					},
				],
			}),
			rootConfig: makeOutputConfig({ collectCoverage: true }),
		});

		expect(pipeline.loadCoverageManifest).not.toHaveBeenCalled();
		expect(pipeline.generateReports).not.toHaveBeenCalled();
	});
});

describe("processCoverage via a one-project run", () => {
	it("should be a no-op when collectCoverage is false", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		setupOutputSpies();

		await outputOneProjectAsync({
			config: makeOutputConfig(),
			dependencies,
			result: makeSingleResult(),
		});

		expect(pipeline.generateReports).not.toHaveBeenCalled();
	});

	it("should warn when coverage data is undefined", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		const spies = setupOutputSpies();

		await outputOneProjectAsync({
			config: makeOutputConfig({ collectCoverage: true }),
			dependencies,
			result: makeSingleResult(),
		});

		expect(spies.stderr).toHaveBeenCalledWith(
			expect.stringContaining("coverage data was empty"),
		);
	});

	it("should suppress empty-coverage warning under silent", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		const spies = setupOutputSpies();

		await outputOneProjectAsync({
			config: makeOutputConfig({ collectCoverage: true, silent: true }),
			dependencies,
			result: makeSingleResult(),
		});

		expect(spies.stderr).not.toHaveBeenCalled();
	});

	it("should warn when manifest is missing", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		const spies = setupOutputSpies();

		await outputOneProjectAsync({
			config: makeOutputConfig({ collectCoverage: true }),
			dependencies,
			result: makeSingleResult({
				runtimeResult: makeExecuteResult({ coverageData: fromAny({ "x.luau": {} }) }),
			}),
		});

		expect(spies.stderr).toHaveBeenCalledWith(
			expect.stringContaining("Coverage manifest not found"),
		);
	});

	it("should suppress missing-manifest warning under silent", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		const spies = setupOutputSpies();

		await outputOneProjectAsync({
			config: makeOutputConfig({ collectCoverage: true, silent: true }),
			dependencies,
			result: makeSingleResult({
				runtimeResult: makeExecuteResult({ coverageData: fromAny({ "x.luau": {} }) }),
			}),
		});

		expect(spies.stderr).not.toHaveBeenCalled();
	});

	it("should generate reports when manifest present", async () => {
		expect.assertions(3);

		const { dependencies } = setupOutput();
		pipeline.loadCoverageManifest.mockReturnValue(fromAny({}));
		const mapped: MappedCoverageResult = fromAny({});
		pipeline.mapCoverageToTypeScript.mockReturnValue(mapped);
		const spies = setupOutputSpies();

		await outputOneProjectAsync({
			config: makeOutputConfig({ collectCoverage: true }),
			dependencies,
			result: makeSingleResult({
				runtimeResult: makeExecuteResult({ coverageData: fromAny({ "x.luau": {} }) }),
			}),
		});

		expect(spies.stdout).toHaveBeenCalledWith(expect.stringContaining(COVERAGE_HEADER));
		expect(spies.stdout).not.toHaveBeenCalledWith("\nundefined\n");
		expect(pipeline.generateReports).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ mapped }),
		);
	});

	it("should suppress coverage header under silent", async () => {
		expect.assertions(2);

		const { dependencies } = setupOutput();
		pipeline.loadCoverageManifest.mockReturnValue(fromAny({}));
		const mapped: MappedCoverageResult = fromAny({});
		pipeline.mapCoverageToTypeScript.mockReturnValue(mapped);
		const spies = setupOutputSpies();

		await outputOneProjectAsync({
			config: makeOutputConfig({ collectCoverage: true, silent: true }),
			dependencies,
			result: makeSingleResult({
				runtimeResult: makeExecuteResult({ coverageData: fromAny({ "x.luau": {} }) }),
			}),
		});

		expect(spies.stdout).not.toHaveBeenCalledWith(expect.stringContaining(COVERAGE_HEADER));
		expect(pipeline.generateReports).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ mapped }),
		);
	});

	it("should fail when coverage threshold not met", async () => {
		expect.assertions(2);

		const { dependencies } = setupOutput();
		pipeline.loadCoverageManifest.mockReturnValue(fromAny({}));
		pipeline.mapCoverageToTypeScript.mockReturnValue(fromAny({}));
		pipeline.checkThresholds.mockReturnValue({
			failures: [{ actual: 50, metric: "lines", threshold: 100 }],
			passed: false,
		});
		const spies = setupOutputSpies();

		const code = await outputOneProjectAsync({
			config: makeOutputConfig({
				collectCoverage: true,
				coverageThreshold: { lines: 100 },
			}),
			dependencies,
			result: makeSingleResult({
				runtimeResult: makeExecuteResult({ coverageData: fromAny({ "x.luau": {} }) }),
			}),
		});

		expect(code).toBe(1);
		expect(spies.stderr).toHaveBeenCalledWith(
			"Coverage threshold not met for lines: 50.00% < 100%\n",
		);
	});

	it("should not generate reports or check thresholds when mapper throws on malformed coverage map", async () => {
		expect.assertions(3);

		const { dependencies } = setupOutput();
		pipeline.loadCoverageManifest.mockReturnValue(fromAny({}));
		const malformed = new Error("Coverage map at out/foo.luau.cov-map.json is malformed");
		pipeline.mapCoverageToTypeScript.mockImplementation(() => {
			throw malformed;
		});
		setupOutputSpies();

		await expect(
			outputOneProjectAsync({
				config: makeOutputConfig({
					collectCoverage: true,
					coverageThreshold: { lines: 100 },
				}),
				dependencies,
				result: makeSingleResult({
					runtimeResult: makeExecuteResult({
						coverageData: fromAny({ "x.luau": {} }),
					}),
				}),
			}),
		).rejects.toBe(malformed);

		expect(pipeline.generateReports).not.toHaveBeenCalled();
		expect(pipeline.checkThresholds).not.toHaveBeenCalled();
	});
});

describe("per-package coverage reports via outputMultiResult", () => {
	it("should report each package's own universe without consulting the single-pkg manifest", async () => {
		expect.assertions(3);

		const { dependencies } = setupOutput();
		setupOutputSpies();

		const fooUniverse: MappedCoverageResult = fromAny({ files: { "foo.ts": {} } });
		await outputMultiResultAsync({
			dependencies,
			result: makeWorkspaceResult({
				coveragePackages: [makeCoverageGate({ universe: fooUniverse })],
			}),
			rootConfig: makeOutputConfig({ collectCoverage: true }),
		});

		expect(pipeline.loadCoverageManifest).not.toHaveBeenCalled();
		expect(pipeline.mapCoverageToTypeScript).not.toHaveBeenCalled();
		expect(pipeline.generateReports).toHaveBeenCalledWith(
			expect.objectContaining({ mapped: fooUniverse }),
		);
	});

	it("should generate reports for per-pkg opt-in even when workspace collectCoverage is false", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		setupOutputSpies();

		const fooUniverse: MappedCoverageResult = fromAny({ files: { "foo.ts": {} } });
		await outputMultiResultAsync({
			dependencies,
			result: makeWorkspaceResult({
				coveragePackages: [makeCoverageGate({ universe: fooUniverse })],
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
				coveragePackages: [makeCoverageGate()],
				reportOptions: makeReportOptions({ silent: true }),
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
				coveragePackages: [
					makeCoverageGate({
						coverageDirectory: "/ws/packages/foo/coverage",
						coverageReporters: ["text"],
					}),
					makeCoverageGate({
						coverageDirectory: "/ws/packages/bar/cov",
						coverageReporters: ["lcov"],
						pkg: "@halcyon/bar",
					}),
				],
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

	it("should not re-filter a package universe that aggregation already narrowed", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeWorkspaceResult({ coveragePackages: [makeCoverageGate()] }),
			rootConfig: makeOutputConfig(),
		});

		expect(pipeline.generateReports).toHaveBeenCalledWith(
			expect.objectContaining({
				collectCoverageFrom: undefined,
				coveragePathIgnorePatterns: undefined,
			}),
		);
	});

	it("should head each package report with the package name", async () => {
		expect.assertions(1);

		const { dependencies } = setupOutput();
		const spies = setupOutputSpies();

		await outputMultiResultAsync({
			dependencies,
			result: makeWorkspaceResult({ coveragePackages: [makeCoverageGate()] }),
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
			result: makeWorkspaceResult({ coveragePackages: [] }),
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
				coveragePackages: [makeCoverageGate({ coverageThreshold: { lines: 100 } })],
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
				coveragePackages: [
					makeCoverageGate({ coverageThreshold: { lines: 70 }, universe: fooUniverse }),
				],
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
				coveragePackages: [
					makeCoverageGate({
						coverageThreshold: { statements: 70 },
						universe: fooUniverse,
					}),
				],
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
			result: makeWorkspaceResult({ coveragePackages: [makeCoverageGate()] }),
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
				coveragePackages: [
					makeCoverageGate({ coverageThreshold: { lines: 70 } }),
					makeCoverageGate({ coverageThreshold: { lines: 80 }, pkg: "@halcyon/bar" }),
				],
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

describe("processCoverage threshold passed branch", () => {
	it("should not write threshold-failed lines when threshold passes", async () => {
		expect.assertions(2);

		const { dependencies } = setupOutput();
		pipeline.loadCoverageManifest.mockReturnValue(fromAny({}));
		pipeline.mapCoverageToTypeScript.mockReturnValue(fromAny({}));
		pipeline.checkThresholds.mockReturnValue({ failures: [], passed: true });
		const spies = setupOutputSpies();

		const code = await outputOneProjectAsync({
			config: makeOutputConfig({
				collectCoverage: true,
				coverageThreshold: { lines: 80 },
			}),
			dependencies,
			result: makeSingleResult({
				runtimeResult: makeExecuteResult({ coverageData: fromAny({ "x.luau": {} }) }),
			}),
		});

		expect(code).toBe(0);
		expect(spies.stderr).not.toHaveBeenCalledWith(
			expect.stringContaining("Coverage threshold not met"),
		);
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

/**
 * Deliberately hostile: a workspace run must ignore every one of these. The
 * values the render actually uses ride on the result below.
 * @returns Config values the workspace render must ignore.
 */
function makeHostileConfig(): ResolvedConfig {
	return {
		...createResolvedConfig(),
		color: true,
		coverageReporters: ["lcov"],
		formatters: ["json"],
		rootDir: "/bootstrap",
		testMatch: ["**/*.spec.ts"],
		testPathIgnorePatterns: [],
	};
}

function makeCoverageWorkspaceResult(): WorkspaceRunResult {
	return fromAny({
		coverageMs: 0,
		coveragePackages: [
			{
				coverageDirectory: "/test/coverage",
				coverageReporters: ["text"],
				pkg: "client",
				universe: mixedCoverage(),
			},
		],
		merged: {},
		mode: "workspace",
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
		reportOptions: {
			color: false,
			formatters: ["agent"],
			rootDir: "/test",
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

		await outputMultiResultAsync({
			result: makeCoverageWorkspaceResult(),
			rootConfig: makeHostileConfig(),
		});

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
