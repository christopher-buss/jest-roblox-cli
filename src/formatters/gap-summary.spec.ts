import { fromPartial } from "@total-typescript/shoehorn";

import { describe, expect, it } from "vitest";

import type { JestResult, TestCaseResult, TestFileResult } from "../types/jest-result.ts";
import { formatGapSummary } from "./gap-summary.ts";

function testCase(status: TestCaseResult["status"], message = ""): TestCaseResult {
	return fromPartial<TestCaseResult>({
		failureMessages: message === "" ? [] : [message],
		status,
	});
}

function file(overrides: Partial<TestFileResult>): TestFileResult {
	return fromPartial<TestFileResult>({ testResults: [], ...overrides });
}

function result(...testResults: Array<TestFileResult>): JestResult {
	return fromPartial<JestResult>({ testResults });
}

describe(formatGapSummary, () => {
	it("should return undefined when the run has no gap tally", () => {
		expect.assertions(1);

		expect(formatGapSummary(undefined, result())).toBeUndefined();
	});

	it("should return undefined when the run hit no gap", () => {
		expect.assertions(1);

		expect(formatGapSummary({}, result())).toBeUndefined();
	});

	it("should rank members by the tests they blocked, then by raises", () => {
		expect.assertions(1);

		const summary = formatGapSummary(
			{ "BasePart.GetTouchingParts": 1, "Sound.Pitch": 5, "Workspace.Gravity": 2 },
			result(
				file({
					testResults: [
						testCase("failed", "gap.spec:9: NotEmulated: BasePart.GetTouchingParts"),
						testCase(
							"failed",
							"gap.spec:12: NotEmulated: Workspace.Gravity (no default)",
						),
						testCase(
							"failed",
							"gap.spec:15: NotEmulated: Workspace.Gravity (no default)",
						),
						testCase("passed"),
					],
				}),
			),
		);

		expect(summary).toBe(
			[
				"Not emulated (3):",
				"  Workspace.Gravity          2 tests blocked, 2 raises",
				"  BasePart.GetTouchingParts  1 test blocked, 1 raise",
				"  Sound.Pitch                0 tests blocked, 5 raises",
			].join("\n"),
		);
	});

	it("should count a suite that failed to run once", () => {
		expect.assertions(1);

		const summary = formatGapSummary(
			{ script: 1 },
			result(file({ failureMessage: "init.luau:3: NotEmulated: script" })),
		);

		expect(summary).toBe("Not emulated (1):\n  script  1 test blocked, 1 raise");
	});

	it("should not count a member whose name only starts with another member", () => {
		expect.assertions(1);

		const summary = formatGapSummary(
			{ "Sound.Play": 1, "Sound.PlayOnRemove": 1 },
			result(file({ testResults: [testCase("failed", "NotEmulated: Sound.PlayOnRemove")] })),
		);

		expect(summary).toBe(
			[
				"Not emulated (2):",
				"  Sound.PlayOnRemove  1 test blocked, 1 raise",
				"  Sound.Play          0 tests blocked, 1 raise",
			].join("\n"),
		);
	});

	it("should rank members that blocked as many tests by raises", () => {
		expect.assertions(1);

		expect(formatGapSummary({ a: 1, b: 3 }, result())).toBe(
			"Not emulated (2):\n  b  0 tests blocked, 3 raises\n  a  0 tests blocked, 1 raise",
		);
	});

	it("should count only failed tests, reading each failure message apart", () => {
		expect.assertions(1);

		const summary = formatGapSummary(
			{ "Sound.Pitch": 1 },
			result(
				file({
					testResults: [
						testCase("passed", "NotEmulated: Sound.Pitch"),
						fromPartial<TestCaseResult>({
							failureMessages: ["gap.spec:9: NotEmulated: Sound.Pitch", "afterEach"],
							status: "failed",
						}),
					],
				}),
			),
		);

		expect(summary).toBe("Not emulated (1):\n  Sound.Pitch  1 test blocked, 1 raise");
	});

	it("should break a tie by member name", () => {
		expect.assertions(1);

		expect(formatGapSummary({ a: 1, b: 1 }, result())).toBe(
			"Not emulated (2):\n  a  0 tests blocked, 1 raise\n  b  0 tests blocked, 1 raise",
		);
	});
});
