import assert from "node:assert";
import type { Except } from "type-fest";

import type { JestResult, SnapshotSummary } from "./jest-result-types.ts";

type JestTotals = Except<JestResult, "numTodoTests" | "snapshot"> & {
	numTodoTests: number;
};

type OptionalCountKey = "filesRemoved" | "unchecked";
type RequiredCountKey = "added" | "matched" | "total" | "unmatched" | "updated";

/**
 * Merge Jest results into one: summed counters and snapshots, the earliest
 * `startTime`, joint `success` and every test result.
 * @param results - Jest results to merge.
 * @returns The merged result.
 */
export function mergeJestResults(results: Array<JestResult>): JestResult {
	const snapshots = results
		.map((result) => result.snapshot)
		.filter((snapshot) => snapshot !== undefined);

	return { ...mergeJestTotals(results), snapshot: mergeSnapshotSummaries(snapshots) };
}

/**
 * Combine a Type Test result with the runtime result.
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
		return mergeJestResults([typecheck, runtime]);
	}

	const result = typecheck ?? runtime;
	assert(result !== undefined, "mergeResults requires at least one result");
	return result;
}

function mergeJestTotals(results: Array<JestResult>): JestTotals {
	const totals: JestTotals = {
		numFailedTests: 0,
		numPassedTests: 0,
		numPendingTests: 0,
		numTodoTests: 0,
		numTotalTests: 0,
		startTime: Infinity,
		success: true,
		testResults: [],
	};

	for (const result of results) {
		totals.numFailedTests += result.numFailedTests;
		totals.numPassedTests += result.numPassedTests;
		totals.numPendingTests += result.numPendingTests;
		totals.numTodoTests += result.numTodoTests ?? 0;
		totals.numTotalTests += result.numTotalTests;
		totals.startTime = Math.min(totals.startTime, result.startTime);
		totals.success &&= result.success;
		totals.testResults.push(...result.testResults);
	}

	return totals;
}

function anyDidUpdate(snapshots: Array<SnapshotSummary>): boolean | undefined {
	const present = snapshots.filter((snapshot) => snapshot.didUpdate !== undefined);
	if (present.length === 0) {
		return undefined;
	}

	return present.some((snapshot) => snapshot.didUpdate === true);
}

function sumOptional(snapshots: Array<SnapshotSummary>, key: OptionalCountKey): number | undefined {
	let total: number | undefined;

	for (const snapshot of snapshots) {
		const value = snapshot[key];
		if (value !== undefined) {
			total = (total ?? 0) + value;
		}
	}

	return total;
}

function sumRequired(snapshots: Array<SnapshotSummary>, key: RequiredCountKey): number {
	return snapshots.reduce((total, snapshot) => total + snapshot[key], 0);
}

function mergeSnapshotSummaries(snapshots: Array<SnapshotSummary>): SnapshotSummary | undefined {
	if (snapshots.length === 0) {
		return undefined;
	}

	const merged: SnapshotSummary = {
		added: sumRequired(snapshots, "added"),
		matched: sumRequired(snapshots, "matched"),
		total: sumRequired(snapshots, "total"),
		unmatched: sumRequired(snapshots, "unmatched"),
		updated: sumRequired(snapshots, "updated"),
	};

	const filesRemoved = sumOptional(snapshots, "filesRemoved");
	if (filesRemoved !== undefined) {
		merged.filesRemoved = filesRemoved;
	}

	const unchecked = sumOptional(snapshots, "unchecked");
	if (unchecked !== undefined) {
		merged.unchecked = unchecked;
	}

	const didUpdate = anyDidUpdate(snapshots);
	if (didUpdate !== undefined) {
		merged.didUpdate = didUpdate;
	}

	return merged;
}
