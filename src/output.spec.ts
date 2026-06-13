import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import process from "node:process";
import type { MockInstance } from "vitest";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { DEFAULT_CONFIG, type ResolvedConfig } from "./config/schema.ts";
import { CoverageMapMalformedError, mapCoverageToTypeScript } from "./coverage-pipeline/mapper.ts";
import {
	checkThresholds,
	generateReports,
	printCoverageHeader,
} from "./coverage-pipeline/reporter.ts";
import { type ExecuteResult, formatExecuteOutput, loadCoverageManifest } from "./executor.ts";
import { formatAgentMultiProject } from "./formatters/agent.ts";
import {
	formatMultiProjectResult,
	formatResult,
	formatTypecheckSummary,
	mergeSnapshotSummaries,
} from "./formatters/formatter.ts";
import { formatAnnotations, formatJobSummary } from "./formatters/github-actions.ts";
import { writeJsonFile } from "./formatters/json.ts";
import { mergeProjectResults, outputMultiResult, outputSingleResult } from "./output.ts";
import type {
	MultiRunResult,
	ProjectResult,
	SingleRunResult,
	WorkspaceRunResult,
} from "./run/types.ts";
import type { JestResult } from "./types/jest-result.ts";
import {
	buildGroupedGameOutput,
	formatGameOutputNotice,
	parseGameOutput,
	writeGameOutput,
	writeGroupedGameOutput,
} from "./utils/game-output.ts";

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});

vi.mock(import("./executor"));
vi.mock(import("./coverage-pipeline/mapper"));
vi.mock(import("./coverage-pipeline/reporter"));
vi.mock(import("./formatters/formatter"));
vi.mock(import("./formatters/agent"));
vi.mock(import("./formatters/github-actions"));
vi.mock(import("./formatters/json"));
vi.mock(import("./utils/game-output"));

type MockedWrite = MockInstance<typeof process.stderr.write>;
type MockedConsole = MockInstance<typeof console.log>;

interface OutputSpies {
	consoleError: MockedConsole;
	consoleLog: MockedConsole;
	stderr: MockedWrite;
	stdout: MockedWrite;
}

const mocks = {
	buildGroupedGameOutput: vi.mocked(buildGroupedGameOutput),
	checkThresholds: vi.mocked(checkThresholds),
	formatAgentMultiProject: vi.mocked(formatAgentMultiProject),
	formatAnnotations: vi.mocked(formatAnnotations),
	formatExecuteOutput: vi.mocked(formatExecuteOutput),
	formatGameOutputNotice: vi.mocked(formatGameOutputNotice),
	formatJobSummary: vi.mocked(formatJobSummary),
	formatMultiProjectResult: vi.mocked(formatMultiProjectResult),
	formatResult: vi.mocked(formatResult),
	formatTypecheckSummary: vi.mocked(formatTypecheckSummary),
	generateReports: vi.mocked(generateReports),
	loadCoverageManifest: vi.mocked(loadCoverageManifest),
	mapCoverageToTypeScript: vi.mocked(mapCoverageToTypeScript),
	mergeSnapshotSummaries: vi.mocked(mergeSnapshotSummaries),
	parseGameOutput: vi.mocked(parseGameOutput),
	printCoverageHeader: vi.mocked(printCoverageHeader),
	writeGameOutput: vi.mocked(writeGameOutput),
	writeGroupedGameOutput: vi.mocked(writeGroupedGameOutput),
	writeJsonFile: vi.mocked(writeJsonFile),
};

function setupCleanup(): void {
	onTestFinished(() => {
		vol.reset();
		delete process.env["GITHUB_STEP_SUMMARY"];
	});
}

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return {
		...DEFAULT_CONFIG,
		formatters: ["default"],
		rootDir: "/test",
		testMatch: ["**/*.spec.ts"],
		testPathIgnorePatterns: [],
		...overrides,
	};
}

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

function makeSingleResult(overrides: Partial<SingleRunResult> = {}): SingleRunResult {
	return {
		mode: "single",
		preCoverageMs: 0,
		runtimeResult: makeExecuteResult(),
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
		merged: {},
		mode: "multi",
		preCoverageMs: 0,
		projectResults: [makeProjectResult()],
		...overrides,
	};
}

function makeWorkspaceResult(overrides: Partial<WorkspaceRunResult> = {}): WorkspaceRunResult {
	return {
		merged: {},
		mode: "workspace",
		preCoverageMs: 0,
		projectResults: [makeProjectResult("@halcyon/foo")],
		...overrides,
	};
}

function setupOutputSpies(): OutputSpies {
	return {
		consoleError: vi.spyOn(console, "error").mockImplementation(() => {}),
		consoleLog: vi.spyOn(console, "log").mockImplementation(() => {}),
		stderr: vi.spyOn(process.stderr, "write").mockReturnValue(true),
		stdout: vi.spyOn(process.stdout, "write").mockReturnValue(true),
	};
}

function setupDefaults(): void {
	setupCleanup();
	mocks.formatResult.mockReturnValue("formatted-result");
	mocks.formatMultiProjectResult.mockReturnValue("formatted-multi");
	mocks.formatAgentMultiProject.mockReturnValue("formatted-agent");
	mocks.formatExecuteOutput.mockReturnValue("formatted-execute");
	mocks.formatTypecheckSummary.mockReturnValue("typecheck-summary");
	mocks.formatAnnotations.mockReturnValue("");
	mocks.formatJobSummary.mockReturnValue("job-summary");
	mocks.formatGameOutputNotice.mockReturnValue("");
	mocks.parseGameOutput.mockReturnValue([]);
	mocks.loadCoverageManifest.mockReturnValue(undefined);
	mocks.checkThresholds.mockReturnValue({ failures: [], passed: true });
	mocks.writeJsonFile.mockResolvedValue(undefined);
}

describe(outputSingleResult, () => {
	it("should print formatted runtime output and return 0 when runtime succeeds", async () => {
		expect.assertions(2);

		setupDefaults();
		const spies = setupOutputSpies();
		const config = makeConfig();

		const code = await outputSingleResult(config, makeSingleResult());

		expect(code).toBe(0);
		expect(spies.consoleLog).toHaveBeenCalledWith("formatted-execute");
	});

	it("should return 1 when runtime fails", async () => {
		expect.assertions(1);

		setupDefaults();
		setupOutputSpies();

		const code = await outputSingleResult(
			makeConfig(),
			makeSingleResult({
				runtimeResult: makeExecuteResult({ result: makeJestResult({ success: false }) }),
			}),
		);

		expect(code).toBe(1);
	});

	it("should return 1 when snapshot writes failed even if tests passed", async () => {
		expect.assertions(1);

		setupDefaults();
		setupOutputSpies();

		const code = await outputSingleResult(
			makeConfig(),
			makeSingleResult({
				runtimeResult: makeExecuteResult({ snapshotWriteFailures: 2 }),
			}),
		);

		expect(code).toBe(1);
	});

	it("should return 1 when obsolete snapshots are present even if tests passed", async () => {
		expect.assertions(1);

		setupDefaults();
		setupOutputSpies();

		const code = await outputSingleResult(
			makeConfig(),
			makeSingleResult({
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
		);

		expect(code).toBe(1);
	});

	it("should propagate snapshotWriteFailures into deferred runtime output", async () => {
		expect.assertions(1);

		setupDefaults();
		setupOutputSpies();

		await outputSingleResult(
			makeConfig(),
			makeSingleResult({
				runtimeResult: makeExecuteResult({ snapshotWriteFailures: 3 }),
			}),
		);

		expect(mocks.formatExecuteOutput).toHaveBeenCalledWith(
			expect.objectContaining({ snapshotWriteFailures: 3 }),
		);
	});

	it("should suppress output when config.silent is true", async () => {
		expect.assertions(1);

		setupDefaults();
		const spies = setupOutputSpies();

		await outputSingleResult(makeConfig({ silent: true }), makeSingleResult());

		expect(spies.consoleLog).not.toHaveBeenCalled();
	});

	it("should write JSON output when config.outputFile is set", async () => {
		expect.assertions(1);

		setupDefaults();
		setupOutputSpies();

		await outputSingleResult(
			makeConfig({ outputFile: "/tmp/results.json" }),
			makeSingleResult(),
		);

		expect(mocks.writeJsonFile).toHaveBeenCalledWith(expect.any(Object), "/tmp/results.json");
	});

	it("should write game output when config.gameOutput is set and runtime present", async () => {
		expect.assertions(1);

		setupDefaults();
		mocks.parseGameOutput.mockReturnValue([{ message: "hi", messageType: 0, timestamp: 0 }]);
		setupOutputSpies();

		await outputSingleResult(
			makeConfig({ gameOutput: "/tmp/game.json" }),
			makeSingleResult({
				runtimeResult: makeExecuteResult({ gameOutput: "raw" }),
			}),
		);

		expect(mocks.writeGameOutput).toHaveBeenCalledOnce();
	});

	it("should print typecheck-only when typecheckResult is present and runtime is undefined", async () => {
		expect.assertions(1);

		setupDefaults();
		const spies = setupOutputSpies();

		await outputSingleResult(
			makeConfig(),
			makeSingleResult({
				runtimeResult: undefined,
				typecheckResult: makeJestResult(),
			}),
		);

		expect(spies.stdout).toHaveBeenCalledWith("typecheck-summary");
	});

	it("should merge typecheck + runtime via default formatter", async () => {
		expect.assertions(1);

		setupDefaults();
		const spies = setupOutputSpies();

		await outputSingleResult(
			makeConfig(),
			makeSingleResult({
				typecheckResult: makeJestResult({ numFailedTests: 1, success: false }),
			}),
		);

		expect(spies.consoleLog).toHaveBeenCalledWith("formatted-result");
	});

	it("should print runtime + typecheck-summary separately for non-default formatter", async () => {
		expect.assertions(2);

		setupDefaults();
		const spies = setupOutputSpies();

		await outputSingleResult(
			makeConfig({ formatters: ["json"] }),
			makeSingleResult({ typecheckResult: makeJestResult() }),
		);

		expect(spies.consoleLog).toHaveBeenCalledWith("formatted-execute");
		expect(spies.stderr).toHaveBeenCalledWith("typecheck-summary");
	});

	it("should print final PASS status when coverage enabled and passed", async () => {
		expect.assertions(1);

		setupDefaults();
		const spies = setupOutputSpies();

		await outputSingleResult(makeConfig({ collectCoverage: true }), makeSingleResult());

		expect(spies.stdout).toHaveBeenCalledWith(expect.stringContaining("PASS"));
	});

	it("should print final FAIL status when coverage enabled and failed", async () => {
		expect.assertions(1);

		setupDefaults();
		const spies = setupOutputSpies();

		await outputSingleResult(
			makeConfig({ collectCoverage: true }),
			makeSingleResult({
				runtimeResult: makeExecuteResult({ result: makeJestResult({ success: false }) }),
			}),
		);

		expect(spies.stdout).toHaveBeenCalledWith(expect.stringContaining("FAIL"));
	});
});

describe(outputMultiResult, () => {
	it("should print formatted multi-project output and return 0 when all succeed", async () => {
		expect.assertions(2);

		setupDefaults();
		const spies = setupOutputSpies();

		const code = await outputMultiResult(makeConfig(), makeMultiResult());

		expect(code).toBe(0);
		expect(spies.consoleLog).toHaveBeenCalledWith("formatted-multi");
	});

	it("should return 1 when any project result fails", async () => {
		expect.assertions(1);

		setupDefaults();
		setupOutputSpies();

		const code = await outputMultiResult(
			makeConfig(),
			makeMultiResult({
				projectResults: [
					{
						displayName: "client",
						result: makeExecuteResult({ result: makeJestResult({ success: false }) }),
					},
				],
			}),
		);

		expect(code).toBe(1);
	});

	it("should return 1 when any project had snapshot write failures", async () => {
		expect.assertions(1);

		setupDefaults();
		setupOutputSpies();

		const code = await outputMultiResult(
			makeConfig(),
			makeMultiResult({
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
		);

		expect(code).toBe(1);
	});

	it("should return 1 when any project had obsolete snapshots", async () => {
		expect.assertions(1);

		setupDefaults();
		mocks.mergeSnapshotSummaries.mockReturnValue({
			added: 0,
			matched: 0,
			total: 0,
			unchecked: 1,
			unmatched: 0,
			updated: 0,
		});
		setupOutputSpies();

		const code = await outputMultiResult(
			makeConfig(),
			makeMultiResult({
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
		);

		expect(code).toBe(1);
	});

	it("should propagate aggregated snapshotWriteFailures to multi formatter", async () => {
		expect.assertions(1);

		setupDefaults();
		setupOutputSpies();

		await outputMultiResult(
			makeConfig(),
			makeMultiResult({
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
		);

		expect(mocks.formatMultiProjectResult).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ snapshotWriteFailures: 5 }),
		);
	});

	it("should suppress output when config.silent is true", async () => {
		expect.assertions(1);

		setupDefaults();
		const spies = setupOutputSpies();

		await outputMultiResult(makeConfig({ silent: true }), makeMultiResult());

		expect(spies.consoleLog).not.toHaveBeenCalled();
	});

	it("should write JSON output when config.outputFile is set", async () => {
		expect.assertions(1);

		setupDefaults();
		setupOutputSpies();

		await outputMultiResult(makeConfig({ outputFile: "/tmp/results.json" }), makeMultiResult());

		expect(mocks.writeJsonFile).toHaveBeenCalledWith(expect.any(Object), "/tmp/results.json");
	});

	it("should NOT write the result file for workspace results (the runner handles it)", async () => {
		expect.assertions(1);

		setupDefaults();
		setupOutputSpies();

		await outputMultiResult(
			makeConfig({ outputFile: "/tmp/results.json" }),
			makeWorkspaceResult(),
		);

		expect(mocks.writeJsonFile).not.toHaveBeenCalled();
	});

	it("should write a grouped aggregated game output file for multi results when config.gameOutput is set", async () => {
		expect.assertions(1);

		setupDefaults();
		mocks.buildGroupedGameOutput.mockReturnValue([
			{ entries: [{ message: "hi", messageType: 0, timestamp: 0 }], project: "client" },
		]);
		setupOutputSpies();

		await outputMultiResult(makeConfig({ gameOutput: "/tmp/game.json" }), makeMultiResult());

		expect(mocks.writeGroupedGameOutput).toHaveBeenCalledOnce();
	});

	it("should NOT write aggregated game output for workspace results (the runner handles it)", async () => {
		expect.assertions(1);

		setupDefaults();
		setupOutputSpies();

		await outputMultiResult(
			makeConfig({ gameOutput: "/tmp/game.json" }),
			makeWorkspaceResult(),
		);

		expect(mocks.writeGroupedGameOutput).not.toHaveBeenCalled();
	});

	it("should fall back to outputSingleResult when no project results but typecheck present", async () => {
		expect.assertions(1);

		setupDefaults();
		const spies = setupOutputSpies();

		await outputMultiResult(
			makeConfig(),
			makeMultiResult({
				projectResults: [],
				typecheckResult: makeJestResult(),
			}),
		);

		expect(spies.stdout).toHaveBeenCalledWith("typecheck-summary");
	});

	it("should use agent formatter when configured", async () => {
		expect.assertions(1);

		setupDefaults();
		const spies = setupOutputSpies();

		await outputMultiResult(makeConfig({ formatters: ["agent"] }), makeMultiResult());

		expect(spies.consoleLog).toHaveBeenCalledWith("formatted-agent");
	});

	it("should use agent formatter with maxFailures option", async () => {
		expect.assertions(1);

		setupDefaults();
		setupOutputSpies();

		await outputMultiResult(
			makeConfig({ formatters: [["agent", { maxFailures: 5 }]] }),
			makeMultiResult(),
		);

		expect(mocks.formatAgentMultiProject).toHaveBeenCalledWith(
			expect.any(Array),
			expect.objectContaining({ maxFailures: 5 }),
		);
	});

	it("should point agent hints at the workspace-resolved sink paths, not config", async () => {
		expect.assertions(1);

		setupDefaults();
		setupOutputSpies();

		await outputMultiResult(
			makeConfig({
				formatters: ["agent"],
				gameOutput: "/root/cfg.log",
				outputFile: "/root/cfg.json",
			}),
			makeWorkspaceResult({
				gameOutput: "/ws/game-output.log",
				outputFile: "/ws/jest-output.log",
			}),
		);

		expect(mocks.formatAgentMultiProject).toHaveBeenCalledWith(
			expect.any(Array),
			expect.objectContaining({
				gameOutput: "/ws/game-output.log",
				outputFile: "/ws/jest-output.log",
			}),
		);
	});

	it("should point agent hints at config paths for multi (non-workspace) runs", async () => {
		expect.assertions(1);

		setupDefaults();
		setupOutputSpies();

		await outputMultiResult(
			makeConfig({
				formatters: ["agent"],
				gameOutput: "/root/cfg.log",
				outputFile: "/root/cfg.json",
			}),
			makeMultiResult(),
		);

		expect(mocks.formatAgentMultiProject).toHaveBeenCalledWith(
			expect.any(Array),
			expect.objectContaining({ gameOutput: "/root/cfg.log", outputFile: "/root/cfg.json" }),
		);
	});

	it("should use json formatter when configured", async () => {
		expect.assertions(1);

		setupDefaults();
		const spies = setupOutputSpies();

		await outputMultiResult(makeConfig({ formatters: ["json"] }), makeMultiResult());

		expect(spies.consoleLog).toHaveBeenCalledWith("formatted-execute");
	});

	it("should print typecheck-summary to stderr for non-default formatter when typecheck present", async () => {
		expect.assertions(1);

		setupDefaults();
		const spies = setupOutputSpies();

		await outputMultiResult(
			makeConfig({ formatters: ["json"] }),
			makeMultiResult({ typecheckResult: makeJestResult() }),
		);

		expect(spies.stderr).toHaveBeenCalledWith("typecheck-summary");
	});

	it("should apply collectCoverageFrom override from result onto config", async () => {
		expect.assertions(1);

		setupDefaults();
		mocks.loadCoverageManifest.mockReturnValue(fromAny({}));
		mocks.mapCoverageToTypeScript.mockReturnValue(fromAny({}));
		setupOutputSpies();

		await outputMultiResult(
			makeConfig({ collectCoverage: true }),
			makeMultiResult({
				collectCoverageFrom: ["src/**/*.ts"],
				projectResults: [
					{
						displayName: "client",
						result: makeExecuteResult({ coverageData: fromAny({ "x.luau": {} }) }),
					},
				],
			}),
		);

		expect(mocks.generateReports).toHaveBeenCalledWith(
			expect.objectContaining({ collectCoverageFrom: ["src/**/*.ts"] }),
		);
	});

	it("should accept WorkspaceRunResult", async () => {
		expect.assertions(2);

		setupDefaults();
		const spies = setupOutputSpies();

		const code = await outputMultiResult(makeConfig(), makeWorkspaceResult());

		expect(code).toBe(0);
		expect(spies.consoleLog).toHaveBeenCalledWith("formatted-multi");
	});
});

describe("processCoverage via outputSingleResult", () => {
	it("should be a no-op when collectCoverage is false", async () => {
		expect.assertions(1);

		setupDefaults();
		setupOutputSpies();

		await outputSingleResult(makeConfig(), makeSingleResult());

		expect(mocks.generateReports).not.toHaveBeenCalled();
	});

	it("should warn when coverage data is undefined", async () => {
		expect.assertions(1);

		setupDefaults();
		const spies = setupOutputSpies();

		await outputSingleResult(makeConfig({ collectCoverage: true }), makeSingleResult());

		expect(spies.stderr).toHaveBeenCalledWith(
			expect.stringContaining("coverage data was empty"),
		);
	});

	it("should suppress empty-coverage warning under silent", async () => {
		expect.assertions(1);

		setupDefaults();
		const spies = setupOutputSpies();

		await outputSingleResult(
			makeConfig({ collectCoverage: true, silent: true }),
			makeSingleResult(),
		);

		expect(spies.stderr).not.toHaveBeenCalled();
	});

	it("should warn when manifest is missing", async () => {
		expect.assertions(1);

		setupDefaults();
		const spies = setupOutputSpies();

		await outputSingleResult(
			makeConfig({ collectCoverage: true }),
			makeSingleResult({
				runtimeResult: makeExecuteResult({ coverageData: fromAny({ "x.luau": {} }) }),
			}),
		);

		expect(spies.stderr).toHaveBeenCalledWith(
			expect.stringContaining("Coverage manifest not found"),
		);
	});

	it("should suppress missing-manifest warning under silent", async () => {
		expect.assertions(1);

		setupDefaults();
		const spies = setupOutputSpies();

		await outputSingleResult(
			makeConfig({ collectCoverage: true, silent: true }),
			makeSingleResult({
				runtimeResult: makeExecuteResult({ coverageData: fromAny({ "x.luau": {} }) }),
			}),
		);

		expect(spies.stderr).not.toHaveBeenCalled();
	});

	it("should generate reports when manifest present", async () => {
		expect.assertions(2);

		setupDefaults();
		mocks.loadCoverageManifest.mockReturnValue(fromAny({}));
		mocks.mapCoverageToTypeScript.mockReturnValue(fromAny({}));
		setupOutputSpies();

		await outputSingleResult(
			makeConfig({ collectCoverage: true }),
			makeSingleResult({
				runtimeResult: makeExecuteResult({ coverageData: fromAny({ "x.luau": {} }) }),
			}),
		);

		expect(mocks.printCoverageHeader).toHaveBeenCalledOnce();
		expect(mocks.generateReports).toHaveBeenCalledOnce();
	});

	it("should suppress coverage header under silent", async () => {
		expect.assertions(2);

		setupDefaults();
		mocks.loadCoverageManifest.mockReturnValue(fromAny({}));
		mocks.mapCoverageToTypeScript.mockReturnValue(fromAny({}));
		setupOutputSpies();

		await outputSingleResult(
			makeConfig({ collectCoverage: true, silent: true }),
			makeSingleResult({
				runtimeResult: makeExecuteResult({ coverageData: fromAny({ "x.luau": {} }) }),
			}),
		);

		expect(mocks.printCoverageHeader).not.toHaveBeenCalled();
		expect(mocks.generateReports).toHaveBeenCalledOnce();
	});

	it("should fail when coverage threshold not met", async () => {
		expect.assertions(2);

		setupDefaults();
		mocks.loadCoverageManifest.mockReturnValue(fromAny({}));
		mocks.mapCoverageToTypeScript.mockReturnValue(fromAny({}));
		mocks.checkThresholds.mockReturnValue({
			failures: [{ actual: 50, metric: "lines", threshold: 100 }],
			passed: false,
		});
		const spies = setupOutputSpies();

		const code = await outputSingleResult(
			makeConfig({
				collectCoverage: true,
				coverageThreshold: { lines: 100 },
			}),
			makeSingleResult({
				runtimeResult: makeExecuteResult({ coverageData: fromAny({ "x.luau": {} }) }),
			}),
		);

		expect(code).toBe(1);
		expect(spies.stderr).toHaveBeenCalledWith(
			expect.stringContaining("Coverage threshold not met"),
		);
	});

	it("should not generate reports or check thresholds when mapper throws on malformed coverage map", async () => {
		expect.assertions(3);

		setupDefaults();
		mocks.loadCoverageManifest.mockReturnValue(fromAny({}));
		mocks.mapCoverageToTypeScript.mockImplementation(() => {
			throw new CoverageMapMalformedError("out/foo.luau.cov-map.json");
		});
		setupOutputSpies();

		await expect(
			outputSingleResult(
				makeConfig({
					collectCoverage: true,
					coverageThreshold: { lines: 100 },
				}),
				makeSingleResult({
					runtimeResult: makeExecuteResult({ coverageData: fromAny({ "x.luau": {} }) }),
				}),
			),
		).rejects.toThrow(CoverageMapMalformedError);

		expect(mocks.generateReports).not.toHaveBeenCalled();
		expect(mocks.checkThresholds).not.toHaveBeenCalled();
	});
});

describe("processCoverage via outputMultiResult (workspace pre-mapped)", () => {
	it("should use coverageMapped directly without consulting the single-pkg manifest", async () => {
		expect.assertions(3);

		setupDefaults();
		setupOutputSpies();

		const preMapped: NonNullable<WorkspaceRunResult["coverageMapped"]> = fromAny({
			files: { "foo.ts": {} },
		});
		await outputMultiResult(
			makeConfig({ collectCoverage: true }),
			makeWorkspaceResult({
				coverageMapped: preMapped,
			}),
		);

		expect(mocks.loadCoverageManifest).not.toHaveBeenCalled();
		expect(mocks.mapCoverageToTypeScript).not.toHaveBeenCalled();
		expect(mocks.generateReports).toHaveBeenCalledWith(
			expect.objectContaining({ mapped: preMapped }),
		);
	});

	it("should still fall back to single-pkg path when coverageMapped is undefined", async () => {
		expect.assertions(1);

		setupDefaults();
		mocks.loadCoverageManifest.mockReturnValue(fromAny({}));
		mocks.mapCoverageToTypeScript.mockReturnValue(fromAny({}));
		setupOutputSpies();

		await outputMultiResult(
			makeConfig({ collectCoverage: true }),
			makeWorkspaceResult({
				projectResults: [
					{
						displayName: "@halcyon/foo",
						result: makeExecuteResult({ coverageData: fromAny({ "x.luau": {} }) }),
					},
				],
			}),
		);

		expect(mocks.mapCoverageToTypeScript).toHaveBeenCalledOnce();
	});

	it("should generate reports for per-pkg opt-in even when workspace collectCoverage is false", async () => {
		expect.assertions(1);

		setupDefaults();
		setupOutputSpies();

		const preMapped: NonNullable<WorkspaceRunResult["coverageMapped"]> = fromAny({
			files: { "foo.ts": {} },
		});
		await outputMultiResult(
			makeConfig(),
			makeWorkspaceResult({
				coverageMapped: preMapped,
			}),
		);

		expect(mocks.generateReports).toHaveBeenCalledWith(
			expect.objectContaining({ mapped: preMapped }),
		);
	});

	it("should enforce coverage thresholds for per-pkg opt-in when workspace collectCoverage is false", async () => {
		expect.assertions(2);

		setupDefaults();
		mocks.checkThresholds.mockReturnValue({
			failures: [{ actual: 50, metric: "lines", threshold: 100 }],
			passed: false,
		});
		const spies = setupOutputSpies();

		const preMapped: NonNullable<WorkspaceRunResult["coverageMapped"]> = fromAny({
			files: { "foo.ts": {} },
		});
		const code = await outputMultiResult(
			makeConfig({ coverageThreshold: { lines: 100 } }),
			makeWorkspaceResult({ coverageMapped: preMapped }),
		);

		expect(code).toBe(1);
		expect(spies.stderr).toHaveBeenCalledWith(
			expect.stringContaining("Coverage threshold not met"),
		);
	});
});

describe("runGitHubActionsFormatter via outputSingleResult", () => {
	it("should be a no-op when formatter not configured", async () => {
		expect.assertions(2);

		setupDefaults();
		setupOutputSpies();

		await outputSingleResult(makeConfig(), makeSingleResult());

		expect(mocks.formatAnnotations).not.toHaveBeenCalled();
		expect(mocks.formatJobSummary).not.toHaveBeenCalled();
	});

	it("should write annotations to stderr", async () => {
		expect.assertions(1);

		setupDefaults();
		mocks.formatAnnotations.mockReturnValue("::error::oops");
		const spies = setupOutputSpies();

		await outputSingleResult(
			makeConfig({ formatters: ["default", "github-actions"] }),
			makeSingleResult(),
		);

		expect(spies.stderr).toHaveBeenCalledWith("::error::oops\n");
	});

	it("should skip annotations when displayAnnotations is false", async () => {
		expect.assertions(1);

		setupDefaults();
		setupOutputSpies();

		await outputSingleResult(
			makeConfig({
				formatters: ["default", ["github-actions", { displayAnnotations: false }]],
			}),
			makeSingleResult(),
		);

		expect(mocks.formatAnnotations).not.toHaveBeenCalled();
	});

	it("should skip annotations when content is empty string", async () => {
		expect.assertions(1);

		setupDefaults();
		mocks.formatAnnotations.mockReturnValue("");
		const spies = setupOutputSpies();

		await outputSingleResult(
			makeConfig({ formatters: ["default", "github-actions"] }),
			makeSingleResult(),
		);

		expect(spies.stderr).not.toHaveBeenCalledWith(expect.stringContaining("::error::"));
	});

	it("should write job summary to GITHUB_STEP_SUMMARY env path", async () => {
		expect.assertions(1);

		setupDefaults();
		setupOutputSpies();
		process.env["GITHUB_STEP_SUMMARY"] = "/tmp/summary.md";
		vol.mkdirSync("/tmp", { recursive: true });
		vol.writeFileSync("/tmp/summary.md", "");

		await outputSingleResult(
			makeConfig({ formatters: ["default", "github-actions"] }),
			makeSingleResult(),
		);

		expect(vol.readFileSync("/tmp/summary.md", "utf8")).toBe("job-summary");
	});

	it("should write job summary to explicit outputPath", async () => {
		expect.assertions(1);

		setupDefaults();
		setupOutputSpies();
		vol.mkdirSync("/tmp", { recursive: true });
		vol.writeFileSync("/tmp/explicit.md", "");

		await outputSingleResult(
			makeConfig({
				formatters: [
					"default",
					["github-actions", { jobSummary: { outputPath: "/tmp/explicit.md" } }],
				],
			}),
			makeSingleResult(),
		);

		expect(vol.readFileSync("/tmp/explicit.md", "utf8")).toBe("job-summary");
	});

	it("should skip job summary when jobSummary.enabled is false", async () => {
		expect.assertions(1);

		setupDefaults();
		setupOutputSpies();
		process.env["GITHUB_STEP_SUMMARY"] = "/tmp/summary.md";

		await outputSingleResult(
			makeConfig({
				formatters: ["default", ["github-actions", { jobSummary: { enabled: false } }]],
			}),
			makeSingleResult(),
		);

		expect(mocks.formatJobSummary).not.toHaveBeenCalled();
	});

	it("should skip job summary when no outputPath available", async () => {
		expect.assertions(1);

		setupDefaults();
		setupOutputSpies();

		await outputSingleResult(
			makeConfig({ formatters: ["default", "github-actions"] }),
			makeSingleResult(),
		);

		expect(mocks.formatJobSummary).not.toHaveBeenCalled();
	});
});

describe("writeGameOutput integration", () => {
	it("should print notice when game output written and not under silent", async () => {
		expect.assertions(1);

		setupDefaults();
		mocks.parseGameOutput.mockReturnValue([{ message: "hi", messageType: 0, timestamp: 0 }]);
		mocks.formatGameOutputNotice.mockReturnValue("Game output written to ...");
		const spies = setupOutputSpies();

		await outputSingleResult(makeConfig({ gameOutput: "/tmp/game.json" }), makeSingleResult());

		expect(spies.consoleError).toHaveBeenCalledWith("Game output written to ...");
	});

	it("should suppress notice when run failed (hintsShown true)", async () => {
		expect.assertions(1);

		setupDefaults();
		mocks.parseGameOutput.mockReturnValue([{ message: "hi", messageType: 0, timestamp: 0 }]);
		const spies = setupOutputSpies();

		await outputSingleResult(
			makeConfig({ gameOutput: "/tmp/game.json" }),
			makeSingleResult({
				runtimeResult: makeExecuteResult({
					gameOutput: "raw",
					result: makeJestResult({ success: false }),
				}),
			}),
		);

		expect(spies.consoleError).not.toHaveBeenCalled();
	});

	it("should suppress notice when notice string is empty", async () => {
		expect.assertions(1);

		setupDefaults();
		mocks.parseGameOutput.mockReturnValue([]);
		mocks.formatGameOutputNotice.mockReturnValue("");
		const spies = setupOutputSpies();

		await outputSingleResult(makeConfig({ gameOutput: "/tmp/game.json" }), makeSingleResult());

		expect(spies.consoleError).not.toHaveBeenCalled();
	});

	it("should print aggregated notice for multi-project mode", async () => {
		expect.assertions(1);

		setupDefaults();
		mocks.parseGameOutput.mockReturnValue([{ message: "hi", messageType: 0, timestamp: 0 }]);
		mocks.formatGameOutputNotice.mockReturnValue("Game output written to ...");
		const spies = setupOutputSpies();

		await outputMultiResult(makeConfig({ gameOutput: "/tmp/game.json" }), makeMultiResult());

		expect(spies.consoleError).toHaveBeenCalledWith("Game output written to ...");
	});

	it("should suppress aggregated notice on failure", async () => {
		expect.assertions(1);

		setupDefaults();
		mocks.parseGameOutput.mockReturnValue([{ message: "hi", messageType: 0, timestamp: 0 }]);
		mocks.formatGameOutputNotice.mockReturnValue("notice");
		const spies = setupOutputSpies();

		await outputMultiResult(
			makeConfig({ gameOutput: "/tmp/game.json" }),
			makeMultiResult({
				projectResults: [
					{
						displayName: "client",
						result: makeExecuteResult({ result: makeJestResult({ success: false }) }),
					},
				],
			}),
		);

		expect(spies.consoleError).not.toHaveBeenCalled();
	});

	it("should suppress aggregated notice when empty", async () => {
		expect.assertions(1);

		setupDefaults();
		mocks.formatGameOutputNotice.mockReturnValue("");
		const spies = setupOutputSpies();

		await outputMultiResult(makeConfig({ gameOutput: "/tmp/game.json" }), makeMultiResult());

		expect(spies.consoleError).not.toHaveBeenCalled();
	});
});

describe(mergeProjectResults, () => {
	it("should return the single result unchanged", () => {
		expect.assertions(1);

		const single = makeExecuteResult();

		expect(mergeProjectResults([single])).toBe(single);
	});

	it("should aggregate counts across multiple results", () => {
		expect.assertions(3);

		const a = makeExecuteResult({
			result: makeJestResult({
				numFailedTests: 1,
				numPassedTests: 2,
				numTotalTests: 3,
				success: false,
			}),
		});
		const b = makeExecuteResult({
			result: makeJestResult({
				numFailedTests: 0,
				numPassedTests: 4,
				numTotalTests: 4,
				success: true,
			}),
		});

		const merged = mergeProjectResults([a, b]);

		expect(merged.result.numFailedTests).toBe(1);
		expect(merged.result.numPassedTests).toBe(6);
		expect(merged.result.success).toBeFalse();
	});

	it("should merge coverage data across results", () => {
		expect.assertions(1);

		const a = makeExecuteResult({ coverageData: fromAny({ "a.luau": { s: { "0": 1 } } }) });
		const b = makeExecuteResult({ coverageData: fromAny({ "b.luau": { s: { "0": 1 } } }) });

		const merged = mergeProjectResults([a, b]);

		expect(merged.coverageData).toBeDefined();
	});

	it("should leave coverage undefined when no result has coverage", () => {
		expect.assertions(1);

		const a = makeExecuteResult();
		const b = makeExecuteResult();

		expect(mergeProjectResults([a, b]).coverageData).toBeUndefined();
	});

	it("should sum testsMs across results", () => {
		expect.assertions(1);

		const a = makeExecuteResult({
			timing: {
				executionMs: 100,
				startTime: 1000,
				testsMs: 50,
				totalMs: 200,
				uploadMs: 50,
			},
		});
		const b = makeExecuteResult({
			timing: {
				executionMs: 100,
				startTime: 2000,
				testsMs: 75,
				totalMs: 200,
				uploadMs: 50,
			},
		});

		expect(mergeProjectResults([a, b]).timing.testsMs).toBe(125);
	});

	it("should sum setupMs when present on any result", () => {
		expect.assertions(1);

		const a = makeExecuteResult({
			timing: {
				executionMs: 100,
				setupMs: 25,
				startTime: 1000,
				testsMs: 50,
				totalMs: 200,
				uploadMs: 50,
			},
		});
		const b = makeExecuteResult({
			timing: {
				executionMs: 100,
				setupMs: 35,
				startTime: 1000,
				testsMs: 50,
				totalMs: 200,
				uploadMs: 50,
			},
		});

		expect(mergeProjectResults([a, b]).timing.setupMs).toBe(60);
	});

	it("should leave setupMs undefined when no result has any setup time", () => {
		expect.assertions(1);
		expect(
			mergeProjectResults([makeExecuteResult(), makeExecuteResult()]).timing.setupMs,
		).toBeUndefined();
	});

	it("should combine source mappers across results", () => {
		expect.assertions(1);

		const sourceMapper = {
			mapFailureMessage: (message: string) => `[a] ${message}`,
			mapFailureWithLocations: (message: string) => ({ locations: [], message }),
			resolveDisplayPath: (testFilePath: string) => testFilePath,
			resolveTestFilePath: (): undefined => undefined,
		};
		const a = makeExecuteResult({ sourceMapper });
		const b = makeExecuteResult({ sourceMapper });

		expect(mergeProjectResults([a, b]).sourceMapper).toBeDefined();
	});

	it("should yield exitCode 0 when all results succeeded", () => {
		expect.assertions(1);
		expect(mergeProjectResults([makeExecuteResult(), makeExecuteResult()]).exitCode).toBe(0);
	});

	it("should yield exitCode 1 when any result failed", () => {
		expect.assertions(1);

		const failing = makeExecuteResult({
			result: makeJestResult({ success: false }),
		});

		expect(mergeProjectResults([makeExecuteResult(), failing]).exitCode).toBe(1);
	});

	it("should sum numTodoTests across results when present", () => {
		expect.assertions(1);

		const a = makeExecuteResult({
			result: makeJestResult({ numTodoTests: 2 }),
		});
		const b = makeExecuteResult({
			result: makeJestResult({ numTodoTests: 3 }),
		});

		expect(mergeProjectResults([a, b]).result.numTodoTests).toBe(5);
	});

	it("should default numTodoTests to 0 when undefined on results", () => {
		expect.assertions(1);

		const a = makeExecuteResult({
			result: { ...makeJestResult(), numTodoTests: undefined },
		});
		const b = makeExecuteResult({
			result: { ...makeJestResult(), numTodoTests: undefined },
		});

		expect(mergeProjectResults([a, b]).result.numTodoTests).toBe(0);
	});

	it("should pass each project's snapshot summary to mergeSnapshotSummaries", () => {
		expect.assertions(1);

		const a = makeExecuteResult({
			result: {
				...makeJestResult(),
				snapshot: { added: 1, matched: 2, total: 3, unmatched: 0, updated: 0 },
			},
		});
		const b = makeExecuteResult({
			result: {
				...makeJestResult(),
				snapshot: { added: 0, matched: 4, total: 5, unmatched: 1, updated: 0 },
			},
		});

		mergeProjectResults([a, b]);

		expect(mocks.mergeSnapshotSummaries).toHaveBeenCalledWith([
			{ added: 1, matched: 2, total: 3, unmatched: 0, updated: 0 },
			{ added: 0, matched: 4, total: 5, unmatched: 1, updated: 0 },
		]);
	});
});

describe("merged typecheck + runtime branches", () => {
	it("should default numTodoTests to 0 when typecheck and runtime both lack it", async () => {
		expect.assertions(1);

		setupDefaults();
		setupOutputSpies();

		const code = await outputSingleResult(
			makeConfig(),
			makeSingleResult({
				runtimeResult: makeExecuteResult({
					result: { ...makeJestResult(), numTodoTests: undefined },
				}),
				typecheckResult: { ...makeJestResult(), numTodoTests: undefined },
			}),
		);

		expect(code).toBe(0);
	});
});

describe("printOutput empty branch", () => {
	it("should not call console.log when formatter returns empty string", async () => {
		expect.assertions(1);

		setupDefaults();
		mocks.formatExecuteOutput.mockReturnValue("");
		const spies = setupOutputSpies();

		await outputSingleResult(makeConfig(), makeSingleResult());

		expect(spies.consoleLog).not.toHaveBeenCalled();
	});
});

describe("processCoverage threshold passed branch", () => {
	it("should not write threshold-failed lines when threshold passes", async () => {
		expect.assertions(2);

		setupDefaults();
		mocks.loadCoverageManifest.mockReturnValue(fromAny({}));
		mocks.mapCoverageToTypeScript.mockReturnValue(fromAny({}));
		mocks.checkThresholds.mockReturnValue({ failures: [], passed: true });
		const spies = setupOutputSpies();

		const code = await outputSingleResult(
			makeConfig({
				collectCoverage: true,
				coverageThreshold: { lines: 80 },
			}),
			makeSingleResult({
				runtimeResult: makeExecuteResult({ coverageData: fromAny({ "x.luau": {} }) }),
			}),
		);

		expect(code).toBe(0);
		expect(spies.stderr).not.toHaveBeenCalledWith(
			expect.stringContaining("Coverage threshold not met"),
		);
	});
});
