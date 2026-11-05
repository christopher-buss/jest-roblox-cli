import assert from "node:assert";

import type { RawCoverageData } from "./coverage-pipeline/coverage-types.ts";
import { mergeRawCoverage } from "./coverage-pipeline/merge-raw-coverage.ts";
import type { ExecuteResult } from "./executor/executor-types.ts";
import { mergeSnapshotSummaries } from "./formatters/formatter.ts";
import { mergeJestTotals } from "./results/merge.ts";
import { combineSourceMappers } from "./source-mapper/index.ts";
import type { JestResult } from "./types/jest-result-types.ts";
import type { TimingResult } from "./types/timing-types.ts";

/**
 * Per-project fields the shared Jest merge doesn't know about — the timing
 * splits, the snapshot-write tally, and the raw coverage fold.
 */
interface ProjectExtras {
	coverageData: RawCoverageData | undefined;
	setupMs: number;
	snapshotWriteFailures: number;
	testsMs: number;
}

/**
 * Combines a Type Test result with the runtime result into one aggregate (counts
 * summed, testResults concatenated, success AND-ed). Shared with the workspace
 * runner, which owns the workspace `outputFile` sink.
 * @param typecheck - Type Test result, if any.
 * @param runtime - Runtime result, if any.
 * @returns The combined result, or the one that is present.
 * @throws When both results are absent.
 */
export function mergeResults(
	typecheck: JestResult | undefined,
	runtime: JestResult | undefined,
): JestResult {
	if (typecheck !== undefined && runtime !== undefined) {
		return {
			numFailedTests: typecheck.numFailedTests + runtime.numFailedTests,
			numPassedTests: typecheck.numPassedTests + runtime.numPassedTests,
			numPendingTests: typecheck.numPendingTests + runtime.numPendingTests,
			numTodoTests: (typecheck.numTodoTests ?? 0) + (runtime.numTodoTests ?? 0),
			numTotalTests: typecheck.numTotalTests + runtime.numTotalTests,
			snapshot: runtime.snapshot,
			startTime: Math.min(typecheck.startTime, runtime.startTime),
			success: typecheck.success && runtime.success,
			testResults: [...typecheck.testResults, ...runtime.testResults],
		};
	}

	const result = typecheck ?? runtime;
	assert(result !== undefined, "mergeResults requires at least one result");
	return result;
}

/**
 * Merge per-project results into one result for reporting.
 * @param results - Results to merge; at least one.
 * @returns The merged result, or the only one as-is.
 * @throws When `results` is empty.
 */
export function mergeProjectResults(results: Array<ExecuteResult>): ExecuteResult {
	const [firstResult] = results;
	assert(firstResult !== undefined, "mergeProjectResults requires at least one result");

	if (results.length === 1) {
		return firstResult;
	}

	const jestResults = results.map((entry) => entry.result);
	const extras = mergeProjectExtras(results);
	const snapshots = jestResults
		.map((result) => result.snapshot)
		.filter((snapshot) => snapshot !== undefined);
	const sourceMappers = results
		.map((entry) => entry.sourceMapper)
		.filter((sourceMapper) => sourceMapper !== undefined);
	const totals = mergeJestTotals(jestResults);

	return {
		coverageData: extras.coverageData,
		exitCode: totals.success && extras.snapshotWriteFailures === 0 ? 0 : 1,
		output: "",
		result: { ...totals, snapshot: mergeSnapshotSummaries(snapshots) },
		snapshotWriteFailures:
			extras.snapshotWriteFailures > 0 ? extras.snapshotWriteFailures : undefined,
		sourceMapper: combineSourceMappers(sourceMappers),
		timing: mergeProjectTiming({ extras, firstResult, results }),
	};
}

function mergeProjectExtras(results: Array<ExecuteResult>): ProjectExtras {
	let coverageData: RawCoverageData | undefined;
	let setupMs = 0;
	let snapshotWriteFailures = 0;
	let testsMs = 0;

	for (const entry of results) {
		setupMs += entry.timing.setupMs ?? 0;
		snapshotWriteFailures += entry.snapshotWriteFailures ?? 0;
		testsMs += entry.timing.testsMs;

		coverageData = mergeRawCoverage(coverageData, entry.coverageData);
	}

	return { coverageData, setupMs, snapshotWriteFailures, testsMs };
}

function mergeProjectTiming({
	extras,
	firstResult,
	results,
}: {
	extras: ProjectExtras;
	firstResult: ExecuteResult;
	results: Array<ExecuteResult>;
}): TimingResult {
	return {
		// Upload, coverage, and execution are one shared phase across the
		// projects, so they read off the first result rather than summing.
		coverageMs: firstResult.timing.coverageMs,
		executionMs: firstResult.timing.executionMs,
		setupMs: extras.setupMs > 0 ? extras.setupMs : undefined,
		startTime: Math.min(...results.map((entry) => entry.timing.startTime)),
		testsMs: extras.testsMs,
		totalMs: Math.max(...results.map((entry) => entry.timing.totalMs)),
		uploadMs: firstResult.timing.uploadMs,
	};
}
