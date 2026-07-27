import type { Except } from "type-fest";

import type { JestResult, SnapshotSummary } from "../types/jest-result.ts";

/**
 * A merged Jest result minus its snapshot summary. `snapshot` is deliberately
 * excluded: each caller merges snapshots at its own seam (`output.ts` collects
 * them alongside the per-project extras it already walks), so the shared merge
 * stays a pure fold over the counters.
 */
export type JestTotals = Except<JestResult, "numTodoTests" | "snapshot"> & {
	numTodoTests: number;
};

type OptionalCountKey = "filesRemoved" | "unchecked";
type RequiredCountKey = "added" | "matched" | "total" | "unmatched" | "updated";

/**
 * Folds the counters, `startTime`, `success`, and `testResults` shared by every
 * Jest-result merge in the CLI. The multi-project merge (`output.ts`) and the
 * multi-project formatter both fold the same eight fields the same way; keeping
 * one implementation means a new result dimension lands in both at once.
 */
export function mergeJestTotals(results: Array<JestResult>): JestTotals {
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

/**
 * Merges per-project snapshot summaries into one. The optional fields stay
 * optional: a field absent from every input stays absent from the output, so a
 * runner that never reports it doesn't gain a phantom zero.
 */
export function mergeSnapshotSummaries(
	snapshots: Array<SnapshotSummary>,
): SnapshotSummary | undefined {
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

function anyDidUpdate(snapshots: Array<SnapshotSummary>): boolean | undefined {
	const present = snapshots.filter((snapshot) => snapshot.didUpdate !== undefined);
	if (present.length === 0) {
		return undefined;
	}

	return present.some((snapshot) => snapshot.didUpdate === true);
}

// Stays `undefined` until some snapshot reports the field, which is what keeps
// an absent field absent rather than summing to a phantom zero.
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
