import { fromAny, fromPartial } from "@total-typescript/shoehorn";

import { describe, expect, it } from "vitest";

import { makeJestResult } from "#test/mocks/spec-results.ts";
import { mergeJestResults, mergeResults } from "./jest-result-merge.ts";
import type { JestResult, SnapshotSummary, TestFileResult } from "./jest-result-types.ts";

function mergeSnapshotSummaries(
	snapshots: Array<SnapshotSummary>,
): ReturnType<typeof mergeJestResults>["snapshot"] {
	return mergeJestResults(snapshots.map((snapshot) => makeJestResult({ snapshot }))).snapshot;
}

describe("mergeJestResults snapshots", () => {
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

describe(mergeJestResults, () => {
	it("should merge the complete Jest result contract exactly", () => {
		expect.assertions(1);

		const firstFile = fromPartial<TestFileResult>({ testFilePath: "first.spec.ts" });
		const secondFile = fromPartial<TestFileResult>({ testFilePath: "second.spec.ts" });
		const merged = mergeJestResults([
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
			snapshot: undefined,
			startTime: 10,
			success: false,
			testResults: [firstFile, secondFile],
		});
	});
});

describe(mergeResults, () => {
	it("should reject when neither result dimension is present", () => {
		expect.assertions(1);

		expect(() => mergeResults(undefined, undefined)).toThrow(
			"mergeResults requires at least one result",
		);
	});

	it("should combine every aggregate field and preserve runtime snapshots", () => {
		expect.assertions(1);

		const typecheckFile = fromAny<TestFileResult, { testFilePath: string }>({
			testFilePath: "typecheck",
		});
		const runtimeFile = fromAny<TestFileResult, { testFilePath: string }>({
			testFilePath: "runtime",
		});
		const runtimeSnapshot = {
			added: 1,
			matched: 2,
			total: 4,
			unmatched: 1,
			updated: 0,
		};
		const typecheck = makeJestResult({
			numFailedTests: 1,
			numPassedTests: 2,
			numPendingTests: 3,
			numTodoTests: undefined,
			numTotalTests: 6,
			startTime: 1000,
			testResults: [typecheckFile],
		});
		const runtime = makeJestResult({
			numFailedTests: 4,
			numPassedTests: 5,
			numPendingTests: 6,
			numTodoTests: 7,
			numTotalTests: 22,
			snapshot: runtimeSnapshot,
			startTime: 2000,
			success: false,
			testResults: [runtimeFile],
		});

		expect(mergeResults(typecheck, runtime)).toStrictEqual({
			numFailedTests: 5,
			numPassedTests: 7,
			numPendingTests: 9,
			numTodoTests: 7,
			numTotalTests: 28,
			snapshot: runtimeSnapshot,
			startTime: 1000,
			success: false,
			testResults: [typecheckFile, runtimeFile],
		});
	});

	it("should count a runtime result with no todo count as zero todos", () => {
		expect.assertions(1);

		const merged = mergeResults(
			makeJestResult({ numTodoTests: 2 }),
			makeJestResult({ numTodoTests: undefined }),
		);

		expect(merged.numTodoTests).toBe(2);
	});
});
