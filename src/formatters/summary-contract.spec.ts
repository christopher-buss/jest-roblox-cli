import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it } from "vitest";

import type { JestResult, SnapshotSummary, TestFileResult } from "../types/jest-result.ts";
import type { TimingResult } from "../types/timing.ts";
import { createTaggedStyles } from "./__fixtures__/tagged-styles.ts";
import { formatLogHints, formatTestSummary } from "./summary.ts";

function makeFile(overrides: Partial<TestFileResult>): TestFileResult {
	return {
		numFailingTests: 0,
		numPassingTests: 0,
		numPendingTests: 0,
		testFilePath: "example.spec.ts",
		testResults: [],
		...overrides,
	};
}

describe(formatLogHints, () => {
	it("should join every applicable hint in a stable order", () => {
		expect.assertions(1);

		const snapshot: SnapshotSummary = {
			added: 0,
			matched: 0,
			total: 1,
			unmatched: 1,
			updated: 0,
		};

		expect(
			formatLogHints(
				{
					color: false,
					gameOutput: "game.log",
					outputFile: "jest.log",
					rootDir: "/repo",
					verbose: false,
					version: "1.0.0",
				},
				createTaggedStyles(),
				snapshot,
			),
		).toBe(
			[
				"<dim>  Inspect your code changes or rerun with `-u` to update snapshots.</dim>",
				"<dim>  View jest.log for full Jest output</dim>",
				"<dim>  View game.log for Roblox game logs</dim>",
			].join("\n"),
		);
	});

	it("should omit the snapshot hint when no snapshots failed", () => {
		expect.assertions(1);

		expect(
			formatLogHints(
				{ color: false, rootDir: "/repo", verbose: false, version: "1.0.0" },
				createTaggedStyles(),
				{ added: 0, matched: 1, total: 1, unmatched: 0, updated: 0 },
			),
		).toBe("");
	});
});

describe(formatTestSummary, () => {
	it("should render exact snapshot, file, test, bail, and timing semantics", () => {
		expect.assertions(1);

		const result: JestResult = fromAny({
			numFailedTests: 1,
			numPassedTests: 2,
			numPendingTests: 3,
			numTotalTests: 6,
			snapshot: {
				added: 1,
				matched: 2,
				total: 6,
				unchecked: 1,
				unmatched: 1,
				updated: 1,
			},
			testResults: [
				makeFile({ numFailingTests: 1, testResults: [fromAny({ status: "failed" })] }),
				makeFile({ failureMessage: "boom" }),
				makeFile({ numPendingTests: 1 }),
				makeFile({ numPassingTests: 1, testResults: [fromAny({ status: "passed" })] }),
			],
		});
		const timing: TimingResult = {
			coverageMs: 50,
			executionMs: 500,
			setupMs: 100,
			startTime: Date.UTC(2025, 0, 2, 13, 4, 5),
			testsMs: 300,
			totalMs: 1000,
			uploadMs: 200,
		};

		expect(
			formatTestSummary(result, timing, createTaggedStyles(), {
				bail: { notRun: 2, ran: 1 },
				snapshotWriteFailures: 2,
				typeErrors: 1,
			}),
		).toMatchSnapshot();
	});
});
