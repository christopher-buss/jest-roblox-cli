import assert from "node:assert";

import type { ExecuteResult } from "../executor/executor-types.ts";
import { formatGapSummary } from "../formatters/gap-summary.ts";
import { mergeProjectResults } from "../results/merge.ts";
import { mergeResults } from "../types/jest-result-merge.ts";
import type { OutputSettings, RunResult } from "../results/run-result-types.ts";
import { type FileSystem, nodeFileSystem } from "../utils/file-system.ts";
import { usesAgentFormatter } from "../config/formatter-selection.ts";
import {
	type CoveragePipeline,
	defaultCoveragePipeline,
	printFinalStatus,
	processCoverage,
} from "./coverage-output.ts";
import { printRunResults } from "./print.ts";
import { writeRunSinksAsync } from "./sinks.ts";

interface OutputDependencies {
	coveragePipeline?: CoveragePipeline;
	fileSystem?: FileSystem;
}

/** Input to `outputRunAsync`. */
export interface OutputRunOptions {
	/** Output collaborators. Each defaults to the real one. */
	dependencies?: OutputDependencies;
	/** The run result to report; its output settings must be resolved. */
	result: RunResult;
}

/**
 * Report a run to the screen and every output sink.
 * @param options - Run result and output collaborators.
 * @returns Process exit code: 0 on pass, 1 on fail.
 */
export async function outputRunAsync({
	dependencies = {},
	result,
}: OutputRunOptions): Promise<number> {
	const { coveragePipeline, fileSystem } = {
		coveragePipeline: defaultCoveragePipeline,
		fileSystem: nodeFileSystem,
		...dependencies,
	};
	const { output: settings, projectResults, typecheckResult } = result;
	assert(settings !== undefined, "a reported run resolves its output settings");

	const runtime =
		projectResults.length > 0
			? mergeProjectResults(projectResults.map((entry) => entry.result))
			: undefined;
	const mergedResult = mergeResults(typecheckResult, runtime?.result);
	const isCoveragePassed = reportRun({
		coveragePipeline,
		result,
		runtime,
		settings,
	});

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

	const areSnapshotsPersisted = (runtime?.snapshotWriteFailures ?? 0) === 0;
	const areSnapshotsCurrent = (mergedResult.snapshot?.unchecked ?? 0) === 0;
	const isPassed =
		mergedResult.success && isCoveragePassed && areSnapshotsPersisted && areSnapshotsCurrent;
	if (!settings.silent && settings.collectCoverage) {
		printFinalStatus(isPassed);
	}

	return isPassed ? 0 : 1;
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

/**
 * Prints a run and reports whether its coverage cleared the thresholds.
 * @param options - Settings, coverage pipeline, merged runtime and run result.
 * @returns Whether coverage cleared the thresholds.
 */
function reportRun({
	coveragePipeline,
	result,
	runtime,
	settings,
}: {
	coveragePipeline: CoveragePipeline;
	result: RunResult;
	runtime: ExecuteResult | undefined;
	settings: OutputSettings;
}): boolean {
	const printResults = (): void => {
		printRunResults({
			bail: result.bail,
 affected: result.affected,
			coverageMs: result.coverageMs,
			projectResults: result.projectResults,
			runtime,
			settings,
			stagingMs: result.stagingMs,
			typecheckResult: result.typecheckResult,
		});
	};
	const shouldDeferResults =
		settings.collectCoverage && usesAgentFormatter(settings);

	if (!shouldDeferResults) {
		printResults();
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
			printResults();
		}
	}
}
