import { fromPartial } from "@total-typescript/shoehorn";

import { describe, expect, it } from "vitest";

import type { GapRecord } from "../backends/interface.ts";
import type { JestResult, TestCaseResult, TestFileResult } from "../types/jest-result.ts";
import { applyFailureGaps, applyGapRecord, listBlocked, MissingGapRecordError } from "./gaps.ts";

const FILE = "ServerScriptService/PkgLute/gap.spec";

function testCase(fullName: string, status: TestCaseResult["status"] = "passed"): TestCaseResult {
	return fromPartial<TestCaseResult>({ failureMessages: [], fullName, status });
}

function file(testResults: Array<TestCaseResult>, testFilePath = FILE): TestFileResult {
	return fromPartial<TestFileResult>({ testFilePath, testResults });
}

function result(...testResults: Array<TestFileResult>): JestResult {
	return fromPartial<JestResult>({ success: true, testResults });
}

function gapRecord(
	attributed: GapRecord["attributed"],
	unattributed: GapRecord["unattributed"] = {},
): GapRecord {
	return { attributed, unattributed };
}

describe(applyGapRecord, () => {
	it("should block a passing test that caught a gap, and fail the run", () => {
		expect.assertions(4);

		const jest = result(file([testCase("caught"), testCase("clean")]));
		applyGapRecord(
			jest,
			gapRecord([
				{ file: FILE, gaps: {} },
				{ file: FILE, gaps: { "BasePart.GetTouchingParts": 1 }, test: "caught" },
				{ file: FILE, gaps: {}, test: "clean" },
			]),
		);

		const [gapFile] = jest.testResults;

		expect(gapFile!.gaps).toStrictEqual({});
		expect(gapFile!.testResults.map((test) => [test.status, test.gaps])).toStrictEqual([
			["passed", { "BasePart.GetTouchingParts": 1 }],
			["passed", {}],
		]);
		expect(jest.success).toBeFalse();
		expect(listBlocked(jest).map((blocked) => blocked.test!.fullName)).toStrictEqual([
			"caught",
		]);
	});

	it("should block every test in a file with a file-level gap", () => {
		expect.assertions(1);

		const jest = result(file([testCase("first"), testCase("second", "failed")]));
		applyGapRecord(
			jest,
			gapRecord([
				{ file: FILE, gaps: { "Sound.Pitch": 2 } },
				{ file: FILE, gaps: { script: 1 }, test: "first" },
				{ file: FILE, gaps: {}, test: "second" },
			]),
		);

		expect(
			listBlocked(jest).map((blocked) => [blocked.test!.fullName, blocked.gaps]),
		).toStrictEqual([
			["first", { "script": 1, "Sound.Pitch": 2 }],
			["second", { "Sound.Pitch": 2 }],
		]);
	});

	it("should give a raise outside every test file to every file", () => {
		expect.assertions(1);

		const other = "ServerScriptService/PkgLute/other.spec";
		const jest = result(file([testCase("a")]), file([testCase("b")], other));
		applyGapRecord(
			jest,
			gapRecord(
				[
					{ file: FILE, gaps: {}, test: "a" },
					{ file: other, gaps: {}, test: "b" },
				],
				{ require: 1 },
			),
		);

		expect(jest.testResults.map((entry) => entry.gaps)).toStrictEqual([
			{ require: 1 },
			{ require: 1 },
		]);
	});

	it("should leave a run with no gap passing", () => {
		expect.assertions(2);

		const jest = result(file([testCase("a"), testCase("skipped", "pending")]));
		applyGapRecord(jest, gapRecord([{ file: FILE, gaps: {}, test: "a" }]));

		expect(jest.success).toBeTrue();
		expect(jest.testResults[0]!.testResults.map((test) => test.gaps)).toStrictEqual([{}, {}]);
	});

	it("should leave a file of skipped tests and a file with no tests clean", () => {
		expect.assertions(2);

		const other = "ServerScriptService/PkgLute/empty.spec";
		const jest = result(file([testCase("skipped", "pending")]), file([], other));
		applyGapRecord(jest, gapRecord([{ file: other, gaps: {} }]));

		expect(listBlocked(jest)).toStrictEqual([]);
		expect(jest.success).toBeTrue();
	});

	it("should refuse a test that ran with no gap record", () => {
		expect.assertions(1);

		const jest = result(file([testCase("a"), testCase("unreported", "failed")]));

		expect(() => {
			applyGapRecord(jest, gapRecord([{ file: FILE, gaps: {}, test: "a" }]));
		}).toThrow(
			new MissingGapRecordError(`The run has no gap record for "unreported" in ${FILE}`),
		);
	});

	it("should refuse a reported test with no result", () => {
		expect.assertions(1);

		const jest = result(file([testCase("a")]));

		expect(() => {
			applyGapRecord(
				jest,
				gapRecord([
					{ file: FILE, gaps: {}, test: "a" },
					{ file: FILE, gaps: {}, test: "lost" },
				]),
			);
		}).toThrow(
			new MissingGapRecordError(
				`The run reported "lost" in ${FILE}, but has no result for it`,
			),
		);
	});

	it("should refuse a reported file with no result", () => {
		expect.assertions(1);

		const jest = result();

		expect(() => {
			applyGapRecord(jest, gapRecord([{ file: FILE, gaps: {} }]));
		}).toThrow(new MissingGapRecordError(`The run reported ${FILE}, but has no result for it`));
	});

	it("should block a file that failed to run with a gap", () => {
		expect.assertions(2);

		const failed = fromPartial<TestFileResult>({
			failureMessage: "NotEmulated: require",
			testFilePath: FILE,
			testResults: [],
		});
		const jest = result(failed);
		applyGapRecord(jest, gapRecord([{ file: FILE, gaps: { require: 1 } }]));

		expect(listBlocked(jest)).toStrictEqual([{ file: failed, gaps: { require: 1 } }]);
		expect(jest.success).toBeFalse();
	});
});

describe(applyFailureGaps, () => {
	it("should give every gap of a run that produced no result to its files", () => {
		expect.assertions(2);

		const failed = fromPartial<TestFileResult>({
			failureMessage: "The run deadlocked",
			testFilePath: "<exec-error>",
			testResults: [],
		});
		const jest = result(failed);
		applyFailureGaps(
			jest,
			gapRecord(
				[
					{ file: FILE, gaps: { script: 1 } },
					{ file: FILE, gaps: { script: 2 }, test: "a" },
				],
				{ require: 1 },
			),
		);

		expect(failed.gaps).toStrictEqual({ require: 1, script: 3 });
		expect(listBlocked(jest)).toHaveLength(1);
	});
});
