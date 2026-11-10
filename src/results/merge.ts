import assert from "node:assert";

import type { RawCoverageData } from "../coverage-data/coverage-types.ts";
import { mergeRawCoverage } from "../coverage-data/merge-raw-coverage.ts";
import type { ExecuteResult } from "../executor/executor-types.ts";
import { combineSourceMappers } from "../source-mapper/index.ts";
import { mergeJestResults } from "../types/jest-result-merge.ts";
import type { TimingResult } from "../types/timing-types.ts";

interface ProjectExtras {
	coverageData: RawCoverageData | undefined;
	setupMs: number;
	snapshotWriteFailures: number;
	testsMs: number;
}

/**
 * Merge per-project results into one result for reporting.
 * @param results - Results to merge; at least one.
 * @returns The merged result.
 * @throws When `results` is empty.
 */
export function mergeProjectResults(results: Array<ExecuteResult>): ExecuteResult {
	const [firstResult] = results;
	assert(firstResult !== undefined, "mergeProjectResults requires at least one result");

	const extras = mergeProjectExtras(results);
	const sourceMappers = results
		.map((entry) => entry.sourceMapper)
		.filter((sourceMapper) => sourceMapper !== undefined);
	const merged = mergeJestResults(results.map((entry) => entry.result));

	return {
		coverageData: extras.coverageData,
		exitCode: merged.success && extras.snapshotWriteFailures === 0 ? 0 : 1,
		result: merged,
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
		coverageMs: firstResult.timing.coverageMs,
		executionMs: firstResult.timing.executionMs,
		setupMs: extras.setupMs > 0 ? extras.setupMs : undefined,
		startTime: Math.min(...results.map((entry) => entry.timing.startTime)),
		testsMs: extras.testsMs,
		totalMs: Math.max(...results.map((entry) => entry.timing.totalMs)),
		uploadMs: firstResult.timing.uploadMs,
	};
}
