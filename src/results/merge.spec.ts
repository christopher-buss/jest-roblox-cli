import { fromPartial } from "@total-typescript/shoehorn";

import { describe, expect, it } from "vitest";

import type { JestResult, TestFileResult } from "../types/jest-result-types.ts";
import { mergeJestTotals, mergeSnapshotSummaries } from "./merge.ts";

describe(mergeSnapshotSummaries, () => {
	it("should aggregate didUpdate as true if any project ran in update mode", () => {
		expect.assertions(1);

		const merged = mergeSnapshotSummaries([
			{ added: 0, didUpdate: true, matched: 1, total: 1, unmatched: 0, updated: 0 },
			{ added: 0, didUpdate: false, matched: 1, total: 1, unmatched: 0, updated: 0 },
		]);

		expect(merged).toStrictEqual({
			added: 0,
			didUpdate: true,
			matched: 2,
			total: 2,
			unmatched: 0,
			updated: 0,
		});
	});

	it("should aggregate didUpdate as false when no project ran in update mode", () => {
		expect.assertions(1);

		const merged = mergeSnapshotSummaries([
			{ added: 0, didUpdate: false, matched: 1, total: 1, unmatched: 0, updated: 0 },
			{ added: 0, didUpdate: false, matched: 1, total: 1, unmatched: 0, updated: 0 },
		]);

		expect(merged).toStrictEqual({
			added: 0,
			didUpdate: false,
			matched: 2,
			total: 2,
			unmatched: 0,
			updated: 0,
		});
	});

	it("should sum unchecked across all projects", () => {
		expect.assertions(1);

		const merged = mergeSnapshotSummaries([
			{ added: 0, matched: 0, total: 0, unchecked: 2, unmatched: 0, updated: 0 },
			{ added: 0, matched: 0, total: 0, unchecked: 3, unmatched: 0, updated: 0 },
			{ added: 0, matched: 0, total: 0, unmatched: 0, updated: 0 },
		]);

		expect(merged).toStrictEqual({
			added: 0,
			matched: 0,
			total: 0,
			unchecked: 5,
			unmatched: 0,
			updated: 0,
		});
	});

	it("should sum filesRemoved across projects so JSON consumers see it", () => {
		expect.assertions(1);

		const merged = mergeSnapshotSummaries([
			{ added: 0, filesRemoved: 1, matched: 0, total: 0, unmatched: 0, updated: 0 },
			{ added: 0, filesRemoved: 2, matched: 0, total: 0, unmatched: 0, updated: 0 },
		]);

		expect(merged).toStrictEqual({
			added: 0,
			filesRemoved: 3,
			matched: 0,
			total: 0,
			unmatched: 0,
			updated: 0,
		});
	});

	it("should return undefined when no snapshots provided", () => {
		expect.assertions(1);

		expect(mergeSnapshotSummaries([])).toBeUndefined();
	});
});

describe(mergeJestTotals, () => {
	it("should merge the complete Jest result contract exactly", () => {
		expect.assertions(1);

		const firstFile = fromPartial<TestFileResult>({ testFilePath: "first.spec.ts" });
		const secondFile = fromPartial<TestFileResult>({ testFilePath: "second.spec.ts" });
		const merged = mergeJestTotals([
			fromPartial<JestResult>({
				numFailedTests: 0,
				numPassedTests: 2,
				numPendingTests: 1,
				numTodoTests: 3,
				numTotalTests: 6,
				startTime: 20,
				success: true,
				testResults: [firstFile],
			}),
			fromPartial<JestResult>({
				numFailedTests: 1,
				numPassedTests: 4,
				numPendingTests: 2,
				numTotalTests: 7,
				startTime: 10,
				success: false,
				testResults: [secondFile],
			}),
		]);

		expect(merged).toStrictEqual({
			numFailedTests: 1,
			numPassedTests: 6,
			numPendingTests: 3,
			numTodoTests: 3,
			numTotalTests: 13,
			startTime: 10,
			success: false,
			testResults: [firstFile, secondFile],
		});
	});
});
