import type { ResolvedConfig } from "./config/schema.ts";
import type { ExecuteResult } from "./executor/executor-types.ts";
import { usesAgentFormatter } from "./formatters/utils.ts";
import {
	type CoveragePipeline,
	extractCoverageDisplayFilter,
	extractCoveragePackages,
	processCoverage,
} from "./reporting/coverage-report.ts";
import {
	type MultiOutputContext,
	printMultiResults,
	printSingleResults,
	type ResultRenderer,
} from "./reporting/print.ts";
import type { MultiRunResult, SingleRunResult, WorkspaceRunResult } from "./run/run-types.ts";
import type { JestResult } from "./types/jest-result-types.ts";

interface ReportDependencies {
	coveragePipeline: CoveragePipeline;
	renderer: ResultRenderer;
}

/** What one single-mode run prints, and what its coverage was filtered by. */
interface SingleRunReport extends Pick<
	SingleRunResult,
	"coverageMs" | "runtimeResult" | "stagingMs" | "typecheckResult"
> {
	agentTextFilter: SingleRunResult["coverageDisplayFilter"];
	mergedResult: JestResult;
}

interface ToMultiOutputContextOptions {
	config: ResolvedConfig;
	merged: ExecuteResult;
	renderer: ResultRenderer;
	result: MultiRunResult | WorkspaceRunResult;
}

/**
 * Prints the run and reports whether its coverage cleared the thresholds.
 * @param options - Config, report collaborators and the run to report.
 * @returns Whether coverage cleared the thresholds.
 */
export function reportSingleRun({
	config,
	dependencies: { coveragePipeline, renderer },
	report: {
		agentTextFilter,
		coverageMs,
		mergedResult,
		runtimeResult,
		stagingMs,
		typecheckResult,
	},
}: {
	config: ResolvedConfig;
	dependencies: ReportDependencies;
	report: SingleRunReport;
}): boolean {
	return emitResultsAndCoverage({
		config,
		coverageEnabled: config.collectCoverage,
		printResults: () => {
			printSingleResults(config, {
				coverageMs,
				mergedResult,
				renderer,
				runtimeResult,
				stagingMs,
				typecheckResult,
			});
		},
		runCoverage: () => {
			return processCoverage({
				agentTextFilter,
				config,
				coverageData: runtimeResult?.coverageData,
				pipeline: coveragePipeline,
			});
		},
	});
}

/**
 * Prints a multi or workspace run and reports whether its coverage cleared the
 * thresholds.
 * @param options - Config, report collaborators, merged result and run result.
 * @returns Whether coverage cleared the thresholds.
 */
export function reportMultiRun({
	config,
	dependencies: { coveragePipeline, renderer },
	merged,
	result,
}: {
	config: ResolvedConfig;
	dependencies: ReportDependencies;
	merged: ExecuteResult;
	result: MultiRunResult | WorkspaceRunResult;
}): boolean {
	const context = toMultiOutputContext({ config, merged, renderer, result });
	const displayFilter = extractCoverageDisplayFilter(result);

	return emitResultsAndCoverage({
		config,
		coverageEnabled: config.collectCoverage,
		printResults: () => {
			printMultiResults(context);
		},
		runCoverage: () => {
			return processCoverage({
				agentTextFilter: displayFilter,
				config,
				coverageData: merged.coverageData,
				packageGates: extractCoveragePackages(result),
				pipeline: coveragePipeline,
			});
		},
	});
}

/**
 * In agent mode the run summary must survive an agent trimming the tail of the
 * output. The coverage report would otherwise print below the summary and bury
 * it, so when coverage is enabled the summary is deferred to print *after* the
 * report. Every other mode keeps the human reading order: results first,
 * coverage last. Single and multi both route through here so the ordering
 * can't drift between modes.
 *
 * `coverageEnabled` only decides *when* the summary prints relative to coverage;
 * it does not gate the coverage call itself. `runCoverage` (`processCoverage`)
 * already no-ops when coverage is off, so it is always invoked here.
 * @param options - Config, coverage flag, and the print and coverage callbacks.
 * @returns Whether coverage cleared the thresholds.
 */
function emitResultsAndCoverage({
	config,
	coverageEnabled,
	printResults,
	runCoverage,
}: {
	config: ResolvedConfig;
	coverageEnabled: boolean;
	printResults: () => void;
	runCoverage: () => boolean;
}): boolean {
	const shouldDeferResults =
		coverageEnabled && usesAgentFormatter(config.formatters, config.verbose);

	if (!shouldDeferResults) {
		printResults();
	}

	try {
		return runCoverage();
	} finally {
		// `finally` so the deferred summary still reaches stdout even when
		// coverage mapping throws (e.g. a malformed coverage map) — losing it
		// would regress the unconditional "results print" of the non-agent path.
		if (shouldDeferResults) {
			printResults();
		}
	}
}

function resolveRunSummary(
	result: MultiRunResult | WorkspaceRunResult,
): Pick<MultiOutputContext, "affected" | "bail"> {
	return result.mode === "workspace" ? { bail: result.bail } : { affected: result.affected };
}

function resolveSinkHints(
	result: MultiRunResult | WorkspaceRunResult,
	config: ResolvedConfig,
): Pick<MultiOutputContext, "gameOutputHint" | "outputFileHint"> {
	const gameOutput = result.mode === "workspace" ? result.gameOutput : config.gameOutput;
	const outputFile = result.mode === "workspace" ? result.outputFile : config.outputFile;

	return {
		gameOutputHint: gameOutput,
		outputFileHint: outputFile,
	};
}

function toMultiOutputContext({
	config,
	merged,
	renderer,
	result,
}: ToMultiOutputContextOptions): MultiOutputContext {
	return {
		...resolveRunSummary(result),
		config,
		...resolveSinkHints(result, config),
		coverageMs: result.coverageMs,
		merged,
		projectResults: result.projectResults,
		renderer,
		stagingMs: result.stagingMs,
		typecheckResult: result.typecheckResult,
	};
}
