import { fromAny } from "@total-typescript/shoehorn";

import process from "node:process";
import { stripVTControlCharacters } from "node:util";
import color from "tinyrainbow";
import { describe, expect, it, onTestFinished } from "vitest";

import {
	EXEC_ERROR_RESULT,
	MIXED_WITH_EXEC_ERROR_RESULT,
	TIMED_OUT_RESULT,
} from "#test/mocks/format-error-results.ts";
import { EMPTY_FILE_RESULT, MIXED_RESULT, PASSING_RESULT } from "#test/mocks/format-results.ts";
import { createTaggedStyles } from "#test/mocks/format-tagged-styles.ts";
import {
	TIMING,
	TIMING_COVERAGE,
	TIMING_NO_UPLOAD,
	TIMING_STAGING,
} from "#test/mocks/format-timing.ts";
import type { JestResult, SnapshotSummary, TestFileResult } from "../types/jest-result-types.ts";
import type { TimingResult } from "../types/timing-types.ts";
import type { FormatOptions } from "./shared.ts";
import {
	countFileBuckets,
	formatBailLine,
	formatFailedTestsHeader,
	formatLogHints,
	formatRunHeader,
	formatTestSummary,
	formatTypeErrorsLine,
} from "./summary.ts";

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

const defaultOptions: FormatOptions = {
	color: true,
	rootDir: "/project",
	verbose: false,
	version: "1.0.0",
};

function createTiming(totalMs: number): TimingResult {
	return {
		executionMs: 100,
		startTime: Date.now(),
		testsMs: 50,
		totalMs,
		uploadMs: 50,
	};
}

function summarizeSnapshot(snapshot: SnapshotSummary): string {
	const result: JestResult = {
		numFailedTests: 0,
		numPassedTests: 1,
		numPendingTests: 0,
		numTotalTests: 1,
		snapshot,
		startTime: 0,
		success: true,
		testResults: [makeFile({ numPassingTests: 1, testFilePath: "test.spec.ts" })],
	};

	return formatTestSummary({ result, timing: createTiming(1000) });
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
			formatLogHints({
				options: {
					color: false,
					gameOutput: "game.log",
					outputFile: "jest.log",
					rootDir: "/repo",
					verbose: false,
					version: "1.0.0",
				},
				snapshot,
				styles: createTaggedStyles(),
			}),
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
			formatLogHints({
				options: { color: false, rootDir: "/repo", verbose: false, version: "1.0.0" },
				snapshot: { added: 0, matched: 1, total: 1, unmatched: 0, updated: 0 },
				styles: createTaggedStyles(),
			}),
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
			formatTestSummary({
				bail: { notRun: 2, ran: 1 },
				result,
				snapshotWriteFailures: 2,
				styles: createTaggedStyles(),
				timing,
				typeErrors: 1,
			}),
		).toMatchSnapshot();
	});
});

describe(countFileBuckets, () => {
	it("should count a file with both passing and pending tests as passed", () => {
		expect.assertions(1);

		expect(
			countFileBuckets(
				fromAny({
					testResults: [makeFile({ numPassingTests: 1, numPendingTests: 1 })],
				}),
			),
		).toStrictEqual({ failed: 0, passed: 1, skipped: 0 });
	});

	it("should count collected files with no tests as passed", () => {
		expect.assertions(1);

		expect(
			countFileBuckets(
				fromAny({
					testResults: [makeFile({}), makeFile({ numPassingTests: 1 })],
				}),
			),
		).toStrictEqual({ failed: 0, passed: 2, skipped: 0 });
	});
});

describe("formatTestSummary default styles", () => {
	it("should color the rows when no styles are passed", () => {
		expect.assertions(1);

		const output = formatTestSummary({
			result: fromAny({
				numFailedTests: 1,
				numPassedTests: 0,
				numPendingTests: 0,
				numTotalTests: 1,
				testResults: [makeFile({ numFailingTests: 1 })],
			}),
			timing: { executionMs: 0, startTime: 0, testsMs: 0, totalMs: 0 },
		});

		expect(stripVTControlCharacters(output)).not.toBe(output);
	});
});

describe(formatRunHeader, () => {
	it("should show the version and root directory", () => {
		expect.assertions(1);

		expect(
			formatRunHeader(
				{ color: false, rootDir: "/repo", version: "1.0.0" },
				createTaggedStyles(),
			),
		).toBe(
			"\n<runBadge> RUN </runBadge> <location>v1.0.0</location> <lineNumber>/repo</lineNumber>\n",
		);
	});

	it("should add the coverage subtitle when coverage is collected", () => {
		expect.assertions(1);

		expect(
			formatRunHeader({
				collectCoverage: true,
				color: false,
				rootDir: "/repo",
				version: "1.0.0",
			}),
		).toBe("\n RUN  v1.0.0 /repo\n      Coverage enabled with istanbul\n");
	});
});

describe(formatFailedTestsHeader, () => {
	it("should title the banner with the failure count", () => {
		expect.assertions(1);

		expect(formatFailedTestsHeader(2)).toContain("Failed Tests 2");
	});
});

describe(formatTypeErrorsLine, () => {
	it("should report no errors when typecheck found none", () => {
		expect.assertions(1);

		expect(formatTypeErrorsLine(0, createTaggedStyles())).toBe(
			"<dim>Type Errors</dim>  <dim>no errors</dim>",
		);
	});
});

describe(formatBailLine, () => {
	it("should pluralize the reached package count", () => {
		expect.assertions(1);

		expect(formatBailLine({ notRun: 1, ran: 2 }, createTaggedStyles())).toBe(
			"<dim>     Bailed</dim>  <summaryFailed>after 2 packages</summaryFailed><dim>, 1 not run</dim>",
		);
	});
});

describe("formatTestSummary optional rows", () => {
	it.for([
		{ name: "absent", snapshot: undefined },
		{ name: "idle", snapshot: { added: 0, matched: 0, total: 0, unmatched: 0, updated: 0 } },
	])("should omit the snapshot rows when the snapshot summary is $name", ({ snapshot }) => {
		expect.assertions(4);

		const output = formatTestSummary({
			result: fromAny({
				numFailedTests: 0,
				numPassedTests: 1,
				numPendingTests: 0,
				numTotalTests: 1,
				snapshot,
				testResults: [makeFile({ numPassingTests: 1 })],
			}),
			styles: createTaggedStyles(),
			timing: {
				executionMs: 400,
				stagingMs: 30,
				startTime: 0,
				testsMs: 100,
				totalMs: 500,
			},
		});

		expect(output).not.toContain("Snapshot");
		expect(output).not.toContain("Type Errors");
		expect(output).not.toContain("Bailed");
		expect(output).toContain(
			"<dim>(environment 300ms, tests 100ms, cli 70ms, staging 30ms)</dim>",
		);
	});
});

describe(formatTestSummary, () => {
	it("should format all passing tests", () => {
		expect.assertions(5);

		const result: JestResult = {
			numFailedTests: 0,
			numPassedTests: 5,
			numPendingTests: 0,
			numTotalTests: 5,
			startTime: 0,
			success: true,
			testResults: [
				{
					numFailingTests: 0,
					numPassingTests: 5,
					numPendingTests: 0,
					testFilePath: "test.spec.ts",
					testResults: [],
				},
			],
		};

		const summary = formatTestSummary({ result, timing: createTiming(2500) });

		expect(summary).toContain("Test Files");
		expect(summary).toContain("5 passed");
		expect(summary).toContain(color.bold(color.green("5 passed")));
		expect(summary).toContain("(5)");
		expect(summary).toContain("2500ms");
	});

	it("should format mixed results", () => {
		expect.assertions(5);

		const result: JestResult = {
			numFailedTests: 2,
			numPassedTests: 7,
			numPendingTests: 1,
			numTotalTests: 10,
			startTime: 0,
			success: false,
			testResults: [
				{
					numFailingTests: 0,
					numPassingTests: 5,
					numPendingTests: 0,
					testFilePath: "pass.spec.ts",
					testResults: [],
				},
				{
					numFailingTests: 2,
					numPassingTests: 2,
					numPendingTests: 1,
					testFilePath: "fail.spec.ts",
					testResults: [],
				},
			],
		};

		const summary = formatTestSummary({ result, timing: createTiming(1000) });

		expect(summary).toContain("Test Files");
		expect(summary).toContain("7 passed");
		expect(summary).toContain("2 failed");
		expect(summary).toContain("1 skipped");
		expect(summary).toContain("(10)");
	});

	it("should order buckets failed-first like vitest", () => {
		expect.assertions(2);

		const summary = stripVTControlCharacters(
			formatTestSummary({ result: MIXED_RESULT, timing: createTiming(1000) }),
		);

		expect(summary).toContain(" Test Files  1 failed | 1 passed (2)");
		expect(summary).toContain("      Tests  1 failed | 4 passed | 1 skipped (6)");
	});

	it("should count a file that collected no tests as passed", () => {
		expect.assertions(2);

		const summary = stripVTControlCharacters(
			formatTestSummary({ result: EMPTY_FILE_RESULT, timing: createTiming(1000) }),
		);

		expect(summary).toContain(" Test Files  2 passed (2)");
		expect(summary).not.toContain("skipped");
	});

	it("should hide snapshots line when no snapshot data", () => {
		expect.assertions(1);

		const result: JestResult = {
			numFailedTests: 0,
			numPassedTests: 1,
			numPendingTests: 0,
			numTotalTests: 1,
			startTime: 0,
			success: true,
			testResults: [
				{
					numFailingTests: 0,
					numPassingTests: 1,
					numPendingTests: 0,
					testFilePath: "test.spec.ts",
					testResults: [],
				},
			],
		};

		const summary = formatTestSummary({ result, timing: createTiming(1000) });

		expect(summary).not.toContain("Snapshots");
	});

	it("should hide snapshots line when no snapshot activity (all zeros)", () => {
		expect.assertions(1);

		const summary = summarizeSnapshot({
			added: 0,
			matched: 0,
			total: 0,
			unmatched: 0,
			updated: 0,
		});

		expect(summary).not.toContain("Snapshots");
	});

	it("should show snapshots line when all snapshots pass", () => {
		expect.assertions(3);

		const summary = summarizeSnapshot({
			added: 0,
			matched: 3,
			total: 3,
			unmatched: 0,
			updated: 0,
		});

		expect(summary).toContain("Snapshots");
		expect(summary).toContain("3 passed");
		expect(summary).toContain("(3)");
	});

	it("should show snapshots line above test files when snapshots fail", () => {
		expect.assertions(4);

		const result: JestResult = {
			numFailedTests: 1,
			numPassedTests: 0,
			numPendingTests: 0,
			numTotalTests: 1,
			snapshot: { added: 0, matched: 1, total: 2, unmatched: 1, updated: 0 },
			startTime: 0,
			success: false,
			testResults: [
				{
					numFailingTests: 1,
					numPassingTests: 0,
					numPendingTests: 0,
					testFilePath: "test.spec.ts",
					testResults: [],
				},
			],
		};

		const summary = formatTestSummary({ result, timing: createTiming(1000) });

		expect(summary).toContain("Snapshots");
		expect(summary).toMatch(/Snapshots.*1 failed/);
		expect(summary).toMatch(/Snapshots.*1 passed/);
		expect(summary.indexOf("Snapshots")).toBeLessThan(summary.indexOf("Test Files"));
	});

	it("should show written count when snapshots are added", () => {
		expect.assertions(2);

		const summary = summarizeSnapshot({
			added: 1,
			matched: 2,
			total: 3,
			unmatched: 0,
			updated: 0,
		});

		expect(summary).toMatch(/Snapshots.*1 written/);
		expect(summary).toMatch(/Snapshots.*2 passed/);
	});

	it("should show updated count when snapshots are updated", () => {
		expect.assertions(2);

		const summary = summarizeSnapshot({
			added: 0,
			matched: 1,
			total: 3,
			unmatched: 0,
			updated: 2,
		});

		expect(summary).toMatch(/Snapshots.*2 updated/);
		expect(summary).toMatch(/Snapshots.*1 passed/);
	});

	it("should report unchecked snapshot keys as the obsolete count", () => {
		expect.assertions(1);

		const summary = summarizeSnapshot({
			added: 0,
			matched: 1,
			total: 1,
			unchecked: 2,
			unmatched: 0,
			updated: 0,
		});

		expect(summary).toMatch(/Snapshots.*2 obsolete/);
	});

	it("should not treat filesRemoved as obsolete (different unit)", () => {
		expect.assertions(2);

		const summary = summarizeSnapshot({
			added: 0,
			filesRemoved: 2,
			matched: 0,
			total: 0,
			unchecked: 0,
			unmatched: 0,
			updated: 0,
		});

		expect(summary).not.toMatch(/Snapshots.*obsolete/);
		expect(summary).not.toContain("  Snapshots");
	});

	it("should show obsolete count even when total is zero", () => {
		expect.assertions(3);

		const summary = summarizeSnapshot({
			added: 0,
			matched: 0,
			total: 0,
			unchecked: 2,
			unmatched: 0,
			updated: 0,
		});

		expect(summary).toContain("Snapshots");
		expect(summary).toMatch(/Snapshots.*2 obsolete/);
		expect(summary).not.toMatch(/Snapshots.*passed/);
	});

	it("should render Snapshot Write line when persistence failures occur", () => {
		expect.assertions(2);

		const result: JestResult = {
			numFailedTests: 0,
			numPassedTests: 1,
			numPendingTests: 0,
			numTotalTests: 1,
			snapshot: { added: 2, matched: 1, total: 3, unmatched: 0, updated: 0 },
			startTime: 0,
			success: true,
			testResults: [
				{
					numFailingTests: 0,
					numPassingTests: 1,
					numPendingTests: 0,
					testFilePath: "test.spec.ts",
					testResults: [],
				},
			],
		};

		const summary = formatTestSummary({
			result,
			snapshotWriteFailures: 1,
			timing: createTiming(1000),
		});
		const writeLine = summary.split("\n").find((line) => line.includes("Snapshot Write"));

		expect(writeLine).toMatch(/1 failed/);
		expect(summary.indexOf("Snapshot Write")).toBeLessThan(summary.lastIndexOf("Snapshots"));
	});

	it("should order snapshot parts as failed, obsolete, updated, written, passed", () => {
		expect.assertions(1);

		const result: JestResult = {
			numFailedTests: 1,
			numPassedTests: 1,
			numPendingTests: 0,
			numTotalTests: 2,
			snapshot: {
				added: 1,
				matched: 2,
				total: 6,
				unchecked: 1,
				unmatched: 1,
				updated: 2,
			},
			startTime: 0,
			success: false,
			testResults: [
				{
					numFailingTests: 1,
					numPassingTests: 1,
					numPendingTests: 0,
					testFilePath: "test.spec.ts",
					testResults: [],
				},
			],
		};

		const summary = formatTestSummary({ result, timing: createTiming(1000) });
		const snapshotLine = summary.split("\n").find((line) => line.includes("Snapshots"));

		expect(snapshotLine).toMatch(/1 failed.*1 obsolete.*2 updated.*1 written.*2 passed.*\(6\)/);
	});

	it("should format test files count with pipe separator", () => {
		expect.assertions(3);

		const result: JestResult = {
			numFailedTests: 1,
			numPassedTests: 3,
			numPendingTests: 0,
			numTotalTests: 4,
			startTime: 0,
			success: false,
			testResults: [
				{
					numFailingTests: 0,
					numPassingTests: 2,
					numPendingTests: 0,
					testFilePath: "pass.spec.ts",
					testResults: [],
				},
				{
					numFailingTests: 1,
					numPassingTests: 1,
					numPendingTests: 0,
					testFilePath: "fail.spec.ts",
					testResults: [],
				},
			],
		};

		const summary = formatTestSummary({ result, timing: createTiming(1000) });

		expect(summary).toContain("Test Files");
		expect(summary).toMatch(/1 failed.*\|.*1 passed/);
		expect(summary).toContain("Tests");
	});
});

describe(formatRunHeader, () => {
	it("should include coverage subtitle when collectCoverage is true", () => {
		expect.assertions(2);

		const header = formatRunHeader({ ...defaultOptions, collectCoverage: true, color: false });

		expect(header).toContain("Coverage enabled with");
		expect(header).toContain("istanbul");
	});

	it("should not include coverage subtitle when collectCoverage is false", () => {
		expect.assertions(1);

		const header = formatRunHeader({ ...defaultOptions, collectCoverage: false, color: false });

		expect(header).not.toContain("Coverage enabled");
	});

	it("should not include coverage subtitle when collectCoverage is omitted", () => {
		expect.assertions(1);

		const header = formatRunHeader({ ...defaultOptions, color: false });

		expect(header).not.toContain("Coverage enabled");
	});
});

describe(formatFailedTestsHeader, () => {
	it("should format header with failure count", () => {
		expect.assertions(2);

		const header = formatFailedTestsHeader(3);

		expect(header).toContain("Failed Tests 3");
		expect(header).toContain("⎯");
	});

	it("should scale separator to terminal width", () => {
		expect.assertions(1);

		const original = process.stdout.columns;
		process.stdout.columns = 40;
		onTestFinished(() => {
			process.stdout.columns = original;
		});

		const header = formatFailedTestsHeader(1, undefined);
		const stripped = stripVTControlCharacters(header);

		expect(stripped).toHaveLength(40);
	});

	it("should fill terminal width with odd-length badge", () => {
		expect.assertions(1);

		const original = process.stdout.columns;
		process.stdout.columns = 41;
		onTestFinished(() => {
			process.stdout.columns = original;
		});

		const header = formatFailedTestsHeader(10, undefined);
		const stripped = stripVTControlCharacters(header);

		expect(stripped).toHaveLength(41);
	});

	it("should fall back to 80 columns when stdout has no columns", () => {
		expect.assertions(1);

		const original = process.stdout.columns;
		Reflect.deleteProperty(process.stdout, "columns");
		onTestFinished(() => {
			process.stdout.columns = original;
		});

		const header = formatFailedTestsHeader(1, undefined);
		const stripped = stripVTControlCharacters(header);

		expect(stripped).toHaveLength(80);
	});
});

describe("formatTestSummary exec errors", () => {
	it("should count exec-error files as failed, not skipped", () => {
		expect.assertions(3);

		const summary = formatTestSummary({
			result: EXEC_ERROR_RESULT,
			timing: createTiming(1000),
		});

		expect(summary).toContain("1 failed");
		expect(summary).not.toContain("skipped");
		expect(summary).toContain("(1)");
	});

	it("should count exec-error files alongside passing files", () => {
		expect.assertions(3);

		const summary = formatTestSummary({
			result: MIXED_WITH_EXEC_ERROR_RESULT,
			timing: createTiming(1000),
		});

		expect(summary).toContain("1 passed");
		expect(summary).toContain("1 failed");
		expect(summary).toContain("(2)");
	});
});

describe("formatTestSummary type errors line", () => {
	it("should show 'no errors' when typeErrors is 0", () => {
		expect.assertions(1);

		const output = formatTestSummary({
			result: PASSING_RESULT,
			timing: TIMING_NO_UPLOAD,
			typeErrors: 0,
		});
		const plain = stripVTControlCharacters(output);

		expect(plain).toContain("Type Errors  no errors");
	});

	it("should show failed count when typeErrors > 0", () => {
		expect.assertions(1);

		const output = formatTestSummary({
			result: PASSING_RESULT,
			timing: TIMING_NO_UPLOAD,
			typeErrors: 3,
		});
		const plain = stripVTControlCharacters(output);

		expect(plain).toContain("Type Errors  3 failed");
	});

	it("should omit type errors line when typeErrors is undefined", () => {
		expect.assertions(1);

		const output = formatTestSummary({ result: PASSING_RESULT, timing: TIMING_NO_UPLOAD });
		const plain = stripVTControlCharacters(output);

		expect(plain).not.toContain("Type Errors");
	});
});

describe("formatTestSummary coverage timing", () => {
	it("should show coverage bucket when coverageMs is provided", () => {
		expect.assertions(2);

		const summary = formatTestSummary({ result: PASSING_RESULT, timing: TIMING_COVERAGE });
		const plain = stripVTControlCharacters(summary);

		expect(plain).toContain("coverage 3000ms");
		expect(plain).toContain("Duration  3250ms");
	});

	it("should subtract coverageMs from cli bucket", () => {
		expect.assertions(1);

		const summary = formatTestSummary({ result: PASSING_RESULT, timing: TIMING_COVERAGE });
		const plain = stripVTControlCharacters(summary);

		// totalMs=3250, uploadMs=50, executionMs=150, coverageMs=3000 → cli=50
		expect(plain).toContain("cli 50ms");
	});

	it("should omit coverage bucket when coverageMs is undefined", () => {
		expect.assertions(1);

		const summary = formatTestSummary({ result: PASSING_RESULT, timing: TIMING });
		const plain = stripVTControlCharacters(summary);

		expect(plain).not.toContain("coverage");
	});

	it("should omit coverage bucket when coverageMs is zero", () => {
		expect.assertions(1);

		const summary = formatTestSummary({
			result: PASSING_RESULT,
			timing: { ...TIMING, coverageMs: 0 },
		});
		const plain = stripVTControlCharacters(summary);

		expect(plain).not.toContain("coverage");
	});
});

describe("formatTestSummary staging timing", () => {
	it("should show staging bucket when stagingMs is provided", () => {
		expect.assertions(2);

		const summary = formatTestSummary({ result: PASSING_RESULT, timing: TIMING_STAGING });
		const plain = stripVTControlCharacters(summary);

		expect(plain).toContain("staging 400ms");
		expect(plain).toContain("Duration  650ms");
	});

	it("should subtract stagingMs from the cli residual", () => {
		expect.assertions(1);

		// totalMs=650, uploadMs=50, executionMs=150, stagingMs=400 -> cli=50
		const summary = formatTestSummary({ result: PASSING_RESULT, timing: TIMING_STAGING });
		const plain = stripVTControlCharacters(summary);

		expect(plain).toContain("cli 50ms");
	});

	it("should omit staging bucket when stagingMs is zero", () => {
		expect.assertions(1);

		const summary = formatTestSummary({
			result: PASSING_RESULT,
			timing: { ...TIMING, stagingMs: 0 },
		});
		const plain = stripVTControlCharacters(summary);

		expect(plain).not.toContain("staging");
	});
});

describe("formatTestSummary setup timing", () => {
	it("should show setup bucket when setupMs is provided", () => {
		expect.assertions(1);

		const summary = formatTestSummary({
			result: PASSING_RESULT,
			timing: {
				...TIMING,
				executionMs: 500,
				setupMs: 200,
				totalMs: 600,
			},
		});
		const plain = stripVTControlCharacters(summary);

		expect(plain).toContain("setup 200ms");
	});

	it("should subtract setupMs from environment bucket", () => {
		expect.assertions(1);

		// executionMs=500, testsMs=100, setupMs=200 → environment=200
		const summary = formatTestSummary({
			result: PASSING_RESULT,
			timing: {
				...TIMING,
				executionMs: 500,
				setupMs: 200,
				totalMs: 600,
			},
		});
		const plain = stripVTControlCharacters(summary);

		expect(plain).toContain("environment 200ms");
	});

	it("should clamp environment to zero when setupMs exceeds available time", () => {
		expect.assertions(1);

		// executionMs=150, testsMs=100, setupMs=200 → would be -150, clamp to 0
		const summary = formatTestSummary({
			result: PASSING_RESULT,
			timing: {
				...TIMING,
				setupMs: 200,
			},
		});
		const plain = stripVTControlCharacters(summary);

		expect(plain).toContain("environment 0ms");
	});

	it("should omit setup bucket when setupMs is undefined", () => {
		expect.assertions(1);

		const summary = formatTestSummary({ result: PASSING_RESULT, timing: TIMING });
		const plain = stripVTControlCharacters(summary);

		expect(plain).not.toContain("setup");
	});

	it("should omit setup bucket when setupMs is zero", () => {
		expect.assertions(1);

		const summary = formatTestSummary({
			result: PASSING_RESULT,
			timing: { ...TIMING, setupMs: 0 },
		});
		const plain = stripVTControlCharacters(summary);

		expect(plain).not.toContain("setup");
	});
});

describe("formatResult timeouts", () => {
	it("should still count the run as failed", () => {
		expect.assertions(2);

		const summary = formatTestSummary({ result: TIMED_OUT_RESULT, timing: createTiming(1000) });

		expect(summary).toContain("1 failed");
		expect(summary).not.toContain("skipped");
	});
});
