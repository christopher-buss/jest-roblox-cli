import { fromAny } from "@total-typescript/shoehorn";

import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import { makeExecuteResult, makeJestResult, makeOutputConfig } from "#test/mocks/spec-results.ts";
import type { ResolvedConfig } from "./config/schema.ts";
import type { loadCoverageManifest } from "./coverage-pipeline/manifest-load.ts";
import type { mapCoverageToTypeScript } from "./coverage-pipeline/mapper.ts";
import type { checkThresholds, generateReports } from "./coverage-pipeline/reporter.ts";
import type { ExecuteResult } from "./executor/executor-types.ts";
import type { formatExecuteOutput } from "./executor/format-output.ts";
import type { formatAgentMultiProject } from "./formatters/agent.ts";
import type {
	formatMultiProjectResult,
	formatResult,
	formatTypecheckReport,
} from "./formatters/formatter.ts";
import { reportMultiRun, reportSingleRun } from "./output-report.ts";
import type { MultiRunResult } from "./run/run-types.ts";
import type { JestResult } from "./types/jest-result-types.ts";

type ReportHarness = ReturnType<typeof setupReport>;

function setupReport() {
	const coveragePipeline = {
		checkThresholds: vi
			.fn<typeof checkThresholds>()
			.mockReturnValue({ failures: [], passed: true }),
		generateReports: vi.fn<typeof generateReports>(),
		loadCoverageManifest: vi.fn<typeof loadCoverageManifest>().mockReturnValue(fromAny({})),
		mapCoverageToTypeScript: vi
			.fn<typeof mapCoverageToTypeScript>()
			.mockReturnValue(fromAny({})),
	};
	const renderer = {
		formatAgentMultiProject: vi
			.fn<typeof formatAgentMultiProject>()
			.mockReturnValue("formatted-agent"),
		formatExecuteOutput: vi
			.fn<typeof formatExecuteOutput>()
			.mockReturnValue("formatted-execute"),
		formatMultiProjectResult: vi
			.fn<typeof formatMultiProjectResult>()
			.mockReturnValue("formatted-multi"),
		formatResult: vi.fn<typeof formatResult>().mockReturnValue("formatted-result"),
		formatTypecheckReport: vi
			.fn<typeof formatTypecheckReport>()
			.mockReturnValue("typecheck-summary"),
	};
	const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(process.stdout, "write").mockReturnValue(true);
	const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

	return {
		consoleLog,
		coveragePipeline,
		dependencies: { coveragePipeline, renderer },
		renderer,
		stderr,
	};
}

function makeMultiResult(merged: ExecuteResult): MultiRunResult {
	return {
		coverageMs: 0,
		merged: {},
		mode: "multi",
		projectResults: [{ displayName: "client", result: merged }],
		stagingMs: 0,
	};
}

function reportSingle({
	config,
	harness: { dependencies },
	runtimeResult = makeExecuteResult({ coverageData: fromAny({ "x.luau": {} }) }),
	mergedResult = runtimeResult.result,
	typecheckResult,
}: {
	config: ResolvedConfig;
	harness: ReportHarness;
	mergedResult?: JestResult;
	runtimeResult?: ExecuteResult;
	typecheckResult?: JestResult;
}): boolean {
	return reportSingleRun({
		config,
		dependencies,
		report: {
			agentTextFilter: undefined,
			coverageMs: 0,
			mergedResult,
			runtimeResult,
			stagingMs: 0,
			typecheckResult,
		},
	});
}

function isCoverageFirst(harness: ReportHarness): boolean {
	const coverageOrder = harness.coveragePipeline.generateReports.mock.invocationCallOrder[0]!;
	const summaryOrder = harness.consoleLog.mock.invocationCallOrder[0]!;

	return coverageOrder < summaryOrder;
}

describe(reportSingleRun, () => {
	it("should print coverage before the agent summary so trimming keeps it", () => {
		expect.assertions(2);

		const harness = setupReport();
		reportSingle({
			config: makeOutputConfig({ collectCoverage: true, formatters: ["agent"] }),
			harness,
		});

		expect(harness.consoleLog).toHaveBeenCalledWith("formatted-execute");

		expect(isCoverageFirst(harness)).toBeTrue();
	});

	it("should keep the summary before coverage for the default formatter", () => {
		expect.assertions(2);

		const harness = setupReport();
		reportSingle({ config: makeOutputConfig({ collectCoverage: true }), harness });

		expect(harness.consoleLog).toHaveBeenCalledExactlyOnceWith("formatted-execute");

		expect(isCoverageFirst(harness)).toBeFalse();
	});

	it("should keep the summary before coverage when verbose opts out of the agent formatter", () => {
		expect.assertions(2);

		const harness = setupReport();
		reportSingle({
			config: makeOutputConfig({
				collectCoverage: true,
				formatters: ["agent"],
				verbose: true,
			}),
			harness,
		});

		expect(harness.consoleLog).toHaveBeenCalledWith("formatted-execute");

		expect(isCoverageFirst(harness)).toBeFalse();
	});

	it("should keep the agent summary inline when coverage is disabled", () => {
		expect.assertions(2);

		const harness = setupReport();
		reportSingle({
			config: makeOutputConfig({ formatters: ["agent"] }),
			harness,
			runtimeResult: makeExecuteResult(),
		});

		expect(harness.consoleLog).toHaveBeenCalledWith("formatted-execute");
		expect(harness.coveragePipeline.generateReports).not.toHaveBeenCalled();
	});

	it("should still print the deferred agent summary when coverage mapping throws", () => {
		expect.assertions(2);

		const harness = setupReport();
		const malformed = new Error("Coverage map at out/foo.luau.cov-map.json is malformed");
		harness.coveragePipeline.mapCoverageToTypeScript.mockImplementation(() => {
			throw malformed;
		});

		expect(() => {
			reportSingle({
				config: makeOutputConfig({ collectCoverage: true, formatters: ["agent"] }),
				harness,
			});
		}).toThrow(malformed);
		expect(harness.consoleLog).toHaveBeenCalledWith("formatted-execute");
	});

	it("should print formatted runtime output and pass when runtime succeeds", () => {
		expect.assertions(2);

		const harness = setupReport();

		const isPassed = reportSingle({
			config: makeOutputConfig(),
			harness,
			runtimeResult: makeExecuteResult(),
		});

		expect(isPassed).toBeTrue();
		expect(harness.consoleLog).toHaveBeenCalledWith("formatted-execute");
	});

	it("should propagate snapshotWriteFailures into deferred runtime output", () => {
		expect.assertions(1);

		const harness = setupReport();
		reportSingle({
			config: makeOutputConfig(),
			harness,
			runtimeResult: makeExecuteResult({ snapshotWriteFailures: 3 }),
		});

		expect(harness.renderer.formatExecuteOutput).toHaveBeenCalledWith(
			expect.objectContaining({ snapshotWriteFailures: 3 }),
		);
	});

	it("should merge typecheck + runtime via default formatter", () => {
		expect.assertions(1);

		const harness = setupReport();
		reportSingle({
			config: makeOutputConfig(),
			harness,
			mergedResult: makeJestResult({
				numFailedTests: 1,
				numPassedTests: 2,
				numTotalTests: 2,
				success: false,
			}),
			runtimeResult: makeExecuteResult(),
			typecheckResult: makeJestResult({ numFailedTests: 1, success: false }),
		});

		expect(harness.consoleLog).toHaveBeenCalledWith("formatted-result");
	});

	it("should print runtime + typecheck-summary separately for non-default formatter", () => {
		expect.assertions(2);

		const harness = setupReport();
		reportSingle({
			config: makeOutputConfig({ formatters: ["json"] }),
			harness,
			mergedResult: makeJestResult({ numPassedTests: 2, numTotalTests: 2 }),
			runtimeResult: makeExecuteResult(),
			typecheckResult: makeJestResult(),
		});

		expect(harness.consoleLog).toHaveBeenCalledWith("formatted-execute");
		expect(harness.stderr).toHaveBeenCalledWith("typecheck-summary");
	});

	it("should route the type error count through the agent formatter", () => {
		expect.assertions(3);

		const harness = setupReport();
		reportSingle({
			config: makeOutputConfig({ formatters: ["agent"] }),
			harness,
			mergedResult: makeJestResult({
				numFailedTests: 2,
				numPassedTests: 2,
				numTotalTests: 2,
				success: false,
			}),
			runtimeResult: makeExecuteResult(),
			typecheckResult: makeJestResult({ numFailedTests: 2, success: false }),
		});

		expect(harness.renderer.formatExecuteOutput).toHaveBeenCalledWith(
			expect.objectContaining({ typeErrorCount: 2 }),
		);
		expect(harness.stderr).toHaveBeenCalledWith("typecheck-summary");
		expect(harness.renderer.formatTypecheckReport).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ includeSummaryRows: false }),
		);
	});

	it("should not call console.log when formatter returns empty string", () => {
		expect.assertions(1);

		const harness = setupReport();
		harness.renderer.formatExecuteOutput.mockReturnValue("");
		reportSingle({ config: makeOutputConfig(), harness, runtimeResult: makeExecuteResult() });

		expect(harness.consoleLog).not.toHaveBeenCalled();
	});
});

describe(reportMultiRun, () => {
	it("should defer the agent summary until after the coverage report", () => {
		expect.assertions(2);

		const harness = setupReport();
		const merged = makeExecuteResult({ coverageData: fromAny({ "x.luau": {} }) });
		reportMultiRun({
			config: makeOutputConfig({ collectCoverage: true, formatters: ["agent"] }),
			dependencies: harness.dependencies,
			merged,
			result: makeMultiResult(merged),
		});

		expect(harness.consoleLog).toHaveBeenCalledWith("formatted-agent");

		expect(isCoverageFirst(harness)).toBeTrue();
	});

	it("should hand a Partial Run's affected count to the formatter", () => {
		expect.assertions(1);

		const harness = setupReport();
		const merged = makeExecuteResult();
		const affected = { affected: 1, relatedTo: ["src/leaf.luau"], total: 2 };
		reportMultiRun({
			config: makeOutputConfig({ formatters: ["agent"] }),
			dependencies: harness.dependencies,
			merged,
			result: { ...makeMultiResult(merged), affected },
		});

		expect(harness.renderer.formatAgentMultiProject).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ affected }),
		);
	});
});
