import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it } from "vitest";

import type { JestResult, TestCaseResult, TestFileResult } from "../types/jest-result.ts";
import { createTaggedStyles } from "./__fixtures__/tagged-styles.ts";
import { computeProjectStats, formatFileSummary } from "./file-summary.ts";

const options = {
	color: false,
	rootDir: "/repo",
	verbose: false,
	version: "1.0.0",
};

function makeTest(overrides: Partial<TestCaseResult>): TestCaseResult {
	return fromAny({
		ancestorTitles: ["suite"],
		failureMessages: [],
		fullName: "suite test",
		status: "passed",
		title: "test",
		...overrides,
	});
}

function makeFile(overrides: Partial<TestFileResult>): TestFileResult {
	return {
		numFailingTests: 0,
		numPassingTests: 0,
		numPendingTests: 0,
		testFilePath: "src/example.spec.ts",
		testResults: [],
		...overrides,
	};
}

describe(formatFileSummary, () => {
	it("should render an all-pending file through the pending style", () => {
		expect.assertions(1);

		expect(
			formatFileSummary(makeFile({ numPendingTests: 2 }), options, createTaggedStyles()),
		).toBe(
			" <pending>↓</pending> <dir>src/</dir><file>example.spec.ts</file> <dim>(2 tests)</dim>",
		);
	});

	it("should render failed groups and individual statuses on separate lines", () => {
		expect.assertions(1);

		const file = makeFile({
			numFailingTests: 1,
			numPassingTests: 1,
			testResults: [
				makeTest({ duration: 10, title: "passes" }),
				makeTest({
					duration: 400,
					fullName: "suite fails",
					status: "failed",
					title: "fails",
				}),
				makeTest({ fullName: "suite waits", status: "todo", title: "waits" }),
			],
		});

		expect(formatFileSummary(file, options, createTaggedStyles())).toMatchSnapshot();
	});

	it("should render only passing tests in verbose passed-file output", () => {
		expect.assertions(1);

		const file = makeFile({
			numPassingTests: 1,
			numPendingTests: 1,
			testResults: [
				makeTest({ duration: 25 }),
				makeTest({ status: "skipped", title: "skip" }),
			],
		});

		expect(
			formatFileSummary(file, { ...options, verbose: true }, createTaggedStyles()),
		).toMatchSnapshot();
	});

	it("should omit durations when passed tests do not report one", () => {
		expect.assertions(1);

		const file = makeFile({ numPassingTests: 1, testResults: [makeTest({})] });

		expect(formatFileSummary(file, options, createTaggedStyles())).toBe(
			" <pass>✓</pass> <dir>src/</dir><file>example.spec.ts</file> <dim>(1 tests</dim><dim>)</dim>",
		);
	});
});

describe(computeProjectStats, () => {
	it("should classify files and sum durations for tests that executed", () => {
		expect.assertions(1);

		const result: JestResult = fromAny({
			numTotalTests: 6,
			testResults: [
				makeFile({
					numFailingTests: 1,
					testResults: [makeTest({ duration: 10, status: "failed" })],
				}),
				makeFile({ failureMessage: "boom" }),
				makeFile({
					numPendingTests: 2,
					testResults: [makeTest({ duration: 99, status: "skipped" })],
				}),
				makeFile({ numPassingTests: 1, testResults: [makeTest({ duration: 20 })] }),
			],
		});

		expect(computeProjectStats(result)).toStrictEqual({
			durationMs: 30,
			failedFiles: 2,
			passedFiles: 1,
			skippedFiles: 1,
			totalTests: 6,
		});
	});
});
