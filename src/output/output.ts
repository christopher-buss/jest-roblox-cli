import assert from "node:assert/strict";

import { usesAgentFormatter } from "../config/formatter-selection.ts";
import type { ExecuteResult } from "../executor/executor-types.ts";
import { formatGapSummary } from "../formatters/gap-summary.ts";
import { mergeProjectResults } from "../results/merge.ts";
import type { OutputSettings, ProjectResult, RunResult } from "../results/run-result-types.ts";
import { mergeResults } from "../types/jest-result-merge.ts";
import type { JestResult } from "../types/jest-result-types.ts";
import { type FileSystem, nodeFileSystem } from "../utils/file-system.ts";
import {
	type CoveragePipeline,
	defaultCoveragePipeline,
	printFinalStatus,
	processCoverage,
} from "./coverage-output.ts";
import { printRunResults, type RunPrintContext } from "./print.ts";
import { writeRunSinksAsync } from "./sinks.ts";

/** Input to `outputRunAsync`. */
export interface OutputRunOptions {
	/** Output collaborators. Each defaults to the real one. */
	dependencies?: OutputDependencies;
	/** The run result to report; its output settings must be resolved. */
	result: RunResult;
}

interface OutputDependencies {
	coveragePipeline?: CoveragePipeline;
	fileSystem?: FileSystem;
}

interface RunReport {
	result: RunResult;
	runtime: ExecuteResult | undefined;
	settings: OutputSettings;
}

const DEFAULT_DEPENDENCIES = {
	coveragePipeline: defaultCoveragePipeline,
	fileSystem: nodeFileSystem,
} satisfies Required<OutputDependencies>;

/**
 * Report a run to the screen and every output sink.
 * @param options - Run result and output collaborators.
 * @returns Process exit code: 0 on pass, 1 on fail.
 */
export async function outputRunAsync({
	dependencies = {},
	result,
}: OutputRunOptions): Promise<number> {
	const { coveragePipeline, fileSystem } = { ...DEFAULT_DEPENDENCIES, ...dependencies };
	const { output: settings, projectResults, typecheckResult } = result;
	assert(settings !== undefined, "a reported run resolves its output settings");

	const runtime = mergeRuntime(projectResults);
	const mergedResult = mergeResults(typecheckResult, runtime?.result);
	const isCoveragePassed = reportRun({ result, runtime, settings }, coveragePipeline);

	if (runtime !== undefined) {
		printGapSummary(settings, runtime);
	}

	await writeRunSinksAsync({
		fileSystem,
		mergedResult,
		projectResults,
		runtime,
		settings,
		typecheckUnits: result.typecheckUnits ?? [],
	});

	const isPassed = isCoveragePassed && hasRunPassed(mergedResult, runtime);
	if (!settings.silent && settings.collectCoverage) {
		printFinalStatus(isPassed);
	}

	return isPassed ? 0 : 1;
}

function mergeRuntime(projectResults: Array<ProjectResult>): ExecuteResult | undefined {
	return projectResults.length > 0
		? mergeProjectResults(projectResults.map((entry) => entry.result))
		: undefined;
}

function hasRunPassed(mergedResult: JestResult, runtime: ExecuteResult | undefined): boolean {
	const areSnapshotsPersisted = (runtime?.snapshotWriteFailures ?? 0) === 0;
	const areSnapshotsCurrent = (mergedResult.snapshot?.unchecked ?? 0) === 0;
	return mergedResult.success && areSnapshotsPersisted && areSnapshotsCurrent;
}

function printGapSummary(settings: OutputSettings, runtime: ExecuteResult): void {
	const summary = formatGapSummary(runtime.result, {
		rootDir: settings.rootDir,
		sourceMapper: runtime.sourceMapper,
	});
	if (summary !== undefined && !settings.silent) {
		console.error(summary);
	}
}

function toPrintContext({ result, runtime, settings }: RunReport): RunPrintContext {
	return {
		affected: result.affected,
		bail: result.bail,
		coverageMs: result.coverageMs,
		projectResults: result.projectResults,
		runtime,
		settings,
		stagingMs: result.stagingMs,
		typecheckResult: result.typecheckResult,
	};
}

function reportRun(report: RunReport, coveragePipeline: CoveragePipeline): boolean {
	const { result, settings } = report;
	const printContext = toPrintContext(report);
	const shouldDeferResults = settings.collectCoverage && usesAgentFormatter(settings);

	if (!shouldDeferResults) {
		printRunResults(printContext);
	}

	try {
		return processCoverage({
			agentTextFilter: result.coverageDisplayFilter,
			coverage: result.coverage,
			pipeline: coveragePipeline,
			settings,
		});
	} finally {
		if (shouldDeferResults) {
			printRunResults(printContext);
		}
	}
}
