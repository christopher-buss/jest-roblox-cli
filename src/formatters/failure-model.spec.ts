import { fromAny, fromPartial } from "@total-typescript/shoehorn";

import process from "node:process";
import { describe, expect, it, onTestFinished } from "vitest";

import { createPlainStyles } from "#test/mocks/format-plain-styles.ts";
import type { MappedLocation, SourceMapper } from "../source-mapper/index.ts";
import type { TestFileResult } from "../types/jest-result-types.ts";
import {
	countFileBuckets,
	describeExecError,
	failureDetail,
	formatFailedTestsHeader,
	formatLogHintLines,
	locateFailure,
	snippetSources,
} from "./failure-model.ts";

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

	it("should count an exec-error file as failed and an all-pending file as skipped", () => {
		expect.assertions(1);

		expect(
			countFileBuckets(
				fromAny({
					testResults: [
						makeFile({ failureMessage: "boom" }),
						makeFile({ numPendingTests: 2 }),
					],
				}),
			),
		).toStrictEqual({ failed: 1, passed: 0, skipped: 1 });
	});
});

describe("locateFailure without a mapper", () => {
	it("should parse supported source extensions with optional columns", () => {
		expect.assertions(1);

		expect([
			locateFailure("at src/a.ts:25:12", undefined).primary,
			locateFailure("at src/b.tsx:2", undefined).primary,
			locateFailure("at src/c.lua:3:4", undefined).primary,
			locateFailure("at src/d.luau:5", undefined).primary,
			locateFailure("at src/e.js:6:7", undefined).primary,
		]).toStrictEqual([
			{ column: 12, line: 25, path: "src/a.ts" },
			{ column: undefined, line: 2, path: "src/b.tsx" },
			{ column: 4, line: 3, path: "src/c.lua" },
			{ column: undefined, line: 5, path: "src/d.luau" },
			undefined,
		]);
	});
});

describe("locateFailure Luau locations in the message", () => {
	it("should parse .luau file location", () => {
		expect.assertions(2);

		const result = locateFailure("path/test.luau:25", undefined).primary;

		expect(result!.path).toBe("path/test.luau");
		expect(result!.line).toBe(25);
	});

	it("should parse .lua file location with column", () => {
		expect.assertions(3);

		const result = locateFailure("path/test.lua:10:5", undefined).primary;

		expect(result!.path).toBe("path/test.lua");
		expect(result!.line).toBe(10);
		expect(result!.column).toBe(5);
	});
});

describe(formatFailedTestsHeader, () => {
	it("should flank the title with the given rule on each side", () => {
		expect.assertions(1);

		expect(formatFailedTestsHeader(3, { rule: 3, styles: createPlainStyles() })).toBe(
			"⎯⎯⎯ Failed Tests 3 ⎯⎯⎯",
		);
	});

	it("should fill the terminal width without a rule", () => {
		expect.assertions(2);

		const original = process.stdout.columns;
		process.stdout.columns = 41;
		onTestFinished(() => {
			process.stdout.columns = original;
		});

		const header = formatFailedTestsHeader(10, { styles: createPlainStyles() });

		expect(header).toHaveLength(41);
		expect(header).toContain(" Failed Tests 10 ");
	});
});

describe(formatLogHintLines, () => {
	it("should name each written log", () => {
		expect.assertions(1);

		expect(
			formatLogHintLines({ gameOutput: "game.log", outputFile: "out.json" }),
		).toStrictEqual([
			"View out.json for full Jest output",
			"View game.log for Roblox game logs",
		]);
	});

	it("should skip unwritten logs", () => {
		expect.assertions(2);

		expect(formatLogHintLines({ outputFile: "out.json" })).toStrictEqual([
			"View out.json for full Jest output",
		]);
		expect(formatLogHintLines({})).toStrictEqual([]);
	});
});

describe(locateFailure, () => {
	it("should fall back to the location written in the message without a mapper", () => {
		expect.assertions(1);

		expect(locateFailure("boom at src/a.ts:4:2", undefined).primary).toStrictEqual({
			column: 2,
			line: 4,
			path: "src/a.ts",
		});
	});

	it("should prefer the mapped TypeScript location, else the Luau one", () => {
		expect.assertions(2);

		function mapper(locations: Array<MappedLocation>): SourceMapper {
			return fromPartial<SourceMapper>({
				mapFailureWithLocations: (message: string) => ({ locations, message }),
			});
		}

		expect(
			locateFailure(
				"x",
				mapper([
					{ luauLine: 9, luauPath: "a.luau", tsColumn: 3, tsLine: 2, tsPath: "a.ts" },
				]),
			).primary,
		).toStrictEqual({ column: 3, line: 2, path: "a.ts" });
		expect(
			locateFailure("x", mapper([{ luauLine: 9, luauPath: "a.luau" }])).primary,
		).toStrictEqual({ line: 9, path: "a.luau" });
	});
});

describe(snippetSources, () => {
	it("should offer no source when the failure names none", () => {
		expect.assertions(1);

		expect(snippetSources(locateFailure("plain failure", undefined))).toStrictEqual([]);
	});
});

describe(failureDetail, () => {
	it("should pick the snapshot diff, then the value pair, then the message", () => {
		expect.assertions(3);

		expect(failureDetail({ message: "m", snapshotDiff: "d" })).toStrictEqual({
			diff: "d",
			kind: "snapshot",
		});
		expect(failureDetail({ expected: "1", message: "m", received: "2" })).toStrictEqual({
			expected: "1",
			kind: "values",
			received: "2",
		});
		expect(failureDetail({ expected: "1", message: "m" })).toStrictEqual({ kind: "message" });
	});
});

describe(describeExecError, () => {
	it("should badge a timed-out suite TIMEOUT and a thrown one FAIL", () => {
		expect.assertions(2);

		const file = { ...makeFile({}), failureMessage: "boom" };

		expect(describeExecError({ ...file, timedOut: true }).badge).toBe("TIMEOUT");
		expect(describeExecError(file)).toMatchObject({
			badge: "FAIL",
			hint: undefined,
			message: "boom",
		});
	});
});
