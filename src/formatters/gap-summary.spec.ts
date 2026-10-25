import { fromPartial } from "@total-typescript/shoehorn";

import { describe, expect, it } from "vitest";

import type { SourceMapper } from "../source-mapper/index.ts";
import type { JestResult, TestCaseResult, TestFileResult } from "../types/jest-result.ts";
import { formatGapSummary } from "./gap-summary.ts";

function testCase(fullName: string, gaps: Record<string, number> = {}): TestCaseResult {
	return fromPartial<TestCaseResult>({ fullName, gaps, status: "passed" });
}

function file(overrides: Partial<TestFileResult>): TestFileResult {
	return fromPartial<TestFileResult>({
		gaps: {},
		testFilePath: "src/gap.spec.ts",
		testResults: [],
		...overrides,
	});
}

function result(...testResults: Array<TestFileResult>): JestResult {
	return fromPartial<JestResult>({ testResults });
}

describe(formatGapSummary, () => {
	it("should return undefined when no test is Blocked", () => {
		expect.assertions(1);

		expect(
			formatGapSummary(result(file({ testResults: [testCase("clean")] }))),
		).toBeUndefined();
	});

	it("should name each Blocked test with its gaps, sorted by member", () => {
		expect.assertions(1);

		const summary = formatGapSummary(
			result(
				file({
					testResults: [
						testCase(
							"lute gap touches a part",
							Object.fromEntries([
								["Workspace.Gravity", 2],
								["BasePart.GetTouchingParts", 1],
							]),
						),
						testCase("lute gap runs clean"),
					],
				}),
			),
		);

		expect(summary).toBe(
			[
				"Blocked (1):",
				"  src/gap.spec.ts > lute gap touches a part",
				"    BasePart.GetTouchingParts  1 raise",
				"    Workspace.Gravity  2 raises",
			].join("\n"),
		);
	});

	it("should block every test of a file with a file-level gap, and name a file with no test", () => {
		expect.assertions(1);

		const summary = formatGapSummary(
			result(
				file({
					gaps: { require: 1 },
					testResults: [testCase("first"), testCase("second")],
				}),
				file({ gaps: { script: 1 }, testFilePath: "src/broken.spec.ts" }),
			),
		);

		expect(summary).toBe(
			[
				"Blocked (3):",
				"  src/gap.spec.ts > first",
				"    require  1 raise",
				"  src/gap.spec.ts > second",
				"    require  1 raise",
				"  src/broken.spec.ts",
				"    script  1 raise",
			].join("\n"),
		);
	});

	it("should add the position in its file to a test whose name repeats there", () => {
		expect.assertions(1);

		const summary = formatGapSummary(
			result(
				file({
					testResults: [
						testCase("unique", { script: 1 }),
						testCase("twice runs", { script: 1 }),
						testCase("twice runs", { script: 2 }),
					],
				}),
			),
		);

		expect(summary).toBe(
			[
				"Blocked (3):",
				"  src/gap.spec.ts > unique",
				"    script  1 raise",
				"  src/gap.spec.ts > twice runs #2",
				"    script  1 raise",
				"  src/gap.spec.ts > twice runs #3",
				"    script  2 raises",
			].join("\n"),
		);
	});

	it("should show each test file by its display path", () => {
		expect.assertions(1);

		const sourceMapper = fromPartial<SourceMapper>({
			resolveDisplayPath: (testFilePath: string) => `shown/${testFilePath}`,
		});
		const summary = formatGapSummary(
			result(file({ testResults: [testCase("a", { script: 1 })] })),
			sourceMapper,
		);

		expect(summary!.split("\n", 2)[1]).toBe("  shown/src/gap.spec.ts > a");
	});
});
