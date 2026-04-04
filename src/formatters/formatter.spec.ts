import { fromPartial } from "@total-typescript/shoehorn";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";

import * as sourceMapperModule from "../source-mapper/index.ts";
import type { SourceMapper, SourceSnippet } from "../source-mapper/index.ts";
import type { JestResult, TestCaseResult, TestFileResult } from "../types/jest-result.ts";
import type { TimingResult } from "../types/timing.ts";
import {
	EXEC_ERROR_RESULT,
	FAILING_RESULT,
	LOADSTRING_ERROR_RESULT,
	MIXED_RESULT,
	MIXED_WITH_EXEC_ERROR_RESULT,
	PASSING_RESULT,
	SKIPPED_RESULT,
	SNAPSHOT_FAILING_RESULT,
	TIMING,
	TIMING_COVERAGE,
	TIMING_NO_UPLOAD,
	TYPECHECK_FAILING_RESULT,
	TYPECHECK_MIXED_RESULT,
	TYPECHECK_PASSING_RESULT,
} from "./__fixtures__/results.ts";
import {
	cleanExecErrorMessage,
	formatFailedTestsHeader,
	formatFailure,
	formatMultiProjectResult,
	type FormatOptions,
	formatProjectBadge,
	formatProjectHeader,
	formatProjectSection,
	formatResult,
	formatRunHeader,
	formatSourceSnippet,
	formatTestSummary,
	formatTypecheckSummary,
	getExecErrorHint,
	parseErrorMessage,
	parseSourceLocation,
} from "./formatter.ts";

function createTiming(totalMs: number): TimingResult {
	return {
		executionMs: 100,
		startTime: Date.now(),
		testsMs: 50,
		totalMs,
		uploadCached: false,
		uploadMs: 50,
	};
}

const defaultOptions: FormatOptions = {
	color: true,
	rootDir: "/project",
	verbose: false,
	version: "1.0.0",
};

describe(formatTestSummary, () => {
	it("should format all passing tests", () => {
		expect.assertions(4);

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

		const summary = formatTestSummary(result, createTiming(2500));

		expect(summary).toContain("Test Files");
		expect(summary).toContain("5 passed");
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

		const summary = formatTestSummary(result, createTiming(1000));

		expect(summary).toContain("Test Files");
		expect(summary).toContain("7 passed");
		expect(summary).toContain("2 failed");
		expect(summary).toContain("1 skipped");
		expect(summary).toContain("(10)");
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

		const summary = formatTestSummary(result, createTiming(1000));

		expect(summary).not.toContain("Snapshots");
	});

	it("should hide snapshots line when all snapshots pass", () => {
		expect.assertions(1);

		const result: JestResult = {
			numFailedTests: 0,
			numPassedTests: 1,
			numPendingTests: 0,
			numTotalTests: 1,
			snapshot: { added: 1, matched: 2, total: 3, unmatched: 0, updated: 0 },
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

		const summary = formatTestSummary(result, createTiming(1000));

		expect(summary).not.toContain("Snapshots");
	});

	it("should show snapshots line above test files when snapshots fail", () => {
		expect.assertions(3);

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

		const summary = formatTestSummary(result, createTiming(1000));

		expect(summary).toContain("1 failed");
		expect(summary).toContain("Snapshots");
		expect(summary.indexOf("Snapshots")).toBeLessThan(summary.indexOf("Test Files"));
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

		const summary = formatTestSummary(result, createTiming(1000));

		expect(summary).toContain("Test Files");
		expect(summary).toMatch(/1 passed.*\|.*1 failed/);
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

describe(parseErrorMessage, () => {
	it("should extract expected and received values", () => {
		expect.assertions(3);

		const message = `expect(received).toBe(expected) -- Object.is equality

Expected: 5
Received: 4`;

		const parsed = parseErrorMessage(message);

		expect(parsed.message).toBe("expect(received).toBe(expected) -- Object.is equality");
		expect(parsed.expected).toBe("5");
		expect(parsed.received).toBe("4");
	});

	it("should handle messages without expected/received", () => {
		expect.assertions(3);

		const message = "Some generic error occurred";

		const parsed = parseErrorMessage(message);

		expect(parsed.message).toBe("Some generic error occurred");
		expect(parsed.expected).toBeUndefined();
		expect(parsed.received).toBeUndefined();
	});

	it("should extract complex expected/received values", () => {
		expect.assertions(2);

		const message = `Expected: {"name": "test"}
Received: {"name": "other"}`;

		const parsed = parseErrorMessage(message);

		expect(parsed.expected).toBe('{"name": "test"}');
		expect(parsed.received).toBe('{"name": "other"}');
	});

	it("should extract snapshot diff from failure message", () => {
		expect.assertions(1);

		const message = [
			"expect(received).toMatchSnapshot()",
			"",
			"Snapshot name: `trait data > Apex matches snapshot 1`",
			"",
			"- Snapshot  - 2",
			"+ Received  + 2",
			"",
			"  Object {",
			'    "name": "Apex",',
			'-   "health": 100,',
			'-   "speed": 50,',
			'+   "health": 150,',
			'+   "speed": 75,',
			"  }",
			"",
			'[string "ReplicatedStorage.traits.spec"]:41',
		].join("\n");

		const parsed = parseErrorMessage(message);

		expect(parsed.snapshotDiff).toBe(
			[
				"- Snapshot  - 2",
				"+ Received  + 2",
				"",
				"  Object {",
				'    "name": "Apex",',
				'-   "health": 100,',
				'-   "speed": 50,',
				'+   "health": 150,',
				'+   "speed": 75,',
				"  }",
			].join("\n"),
		);
	});

	it("should not set expected/received for snapshot failures", () => {
		expect.assertions(2);

		const message = [
			"expect(received).toMatchSnapshot()",
			"",
			"- Snapshot  - 1",
			"+ Received  + 1",
			"",
			'-   "health": 100,',
			'+   "health": 150,',
		].join("\n");

		const parsed = parseErrorMessage(message);

		expect(parsed.expected).toBeUndefined();
		expect(parsed.received).toBeUndefined();
	});

	it("should extract values from toThrow with labeled expected/received", () => {
		expect.assertions(2);

		const message = `expect(received).toThrow(expected)

Expected substring: ".pass"
Received value:     "some error message"`;

		const parsed = parseErrorMessage(message);

		expect(parsed.expected).toBe('".pass"');
		expect(parsed.received).toBe('"some error message"');
	});
});

describe(parseSourceLocation, () => {
	it("should parse .luau file location", () => {
		expect.assertions(2);

		const result = parseSourceLocation("path/test.luau:25");

		expect(result?.path).toBe("path/test.luau");
		expect(result?.line).toBe(25);
	});

	it("should parse .lua file location with column", () => {
		expect.assertions(3);

		const result = parseSourceLocation("path/test.lua:10:5");

		expect(result?.path).toBe("path/test.lua");
		expect(result?.line).toBe(10);
		expect(result?.column).toBe(5);
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

		try {
			const header = formatFailedTestsHeader(1, undefined);
			const stripped = stripVTControlCharacters(header);

			expect(stripped).toHaveLength(40);
		} finally {
			process.stdout.columns = original;
		}
	});

	it("should fill terminal width with odd-length badge", () => {
		expect.assertions(1);

		const original = process.stdout.columns;
		process.stdout.columns = 41;

		try {
			const header = formatFailedTestsHeader(10, undefined);
			const stripped = stripVTControlCharacters(header);

			expect(stripped).toHaveLength(41);
		} finally {
			process.stdout.columns = original;
		}
	});

	it("should fall back to 80 columns when stdout has no columns", () => {
		expect.assertions(1);

		const original = process.stdout.columns;
		delete (process.stdout as unknown as Record<string, unknown>)["columns"];

		try {
			const header = formatFailedTestsHeader(1, undefined);
			const stripped = stripVTControlCharacters(header);

			expect(stripped).toHaveLength(80);
		} finally {
			process.stdout.columns = original;
		}
	});
});

describe(formatSourceSnippet, () => {
	it("should format snippet with line numbers and caret", () => {
		expect.assertions(4);

		const snippet: SourceSnippet = {
			column: 10,
			failureLine: 2,
			lines: [
				{ content: "function test() {", num: 1 },
				{ content: "  expect(true).toBe(false);", num: 2 },
				{ content: "}", num: 3 },
			],
		};

		const formatted = formatSourceSnippet(snippet, "test.ts");

		expect(formatted).toContain("❯ test.ts:2:10");
		expect(formatted).toContain("1|");
		expect(formatted).toContain("2|");
		expect(formatted).toContain("^");
	});

	it("should format snippet without column", () => {
		expect.assertions(2);

		const snippet: SourceSnippet = {
			failureLine: 1,
			lines: [{ content: "print('hello')", num: 1 }],
		};

		const formatted = formatSourceSnippet(snippet, "test.ts");

		expect(formatted).toContain("❯ test.ts:1");
		expect(formatted).not.toContain(":1:");
	});
});

describe(formatFailure, () => {
	it("should format test failure with vitest-style diff", () => {
		expect.assertions(5);

		const test: TestCaseResult = {
			ancestorTitles: ["Player"],
			duration: 10,
			failureMessages: ["expect(received).toBe(expected)\n\nExpected: 100\nReceived: 0"],
			fullName: "Player should have health",
			status: "failed",
			title: "should have health",
		};

		const formatted = formatFailure({ filePath: "src/player.spec.ts", test });

		expect(formatted).toContain("FAIL");
		expect(formatted).toContain("src/player.spec.ts > Player > should have health");
		expect(formatted).toContain("- Expected");
		expect(formatted).toContain("+ Received");
		expect(formatted).toContain("- 100");
	});

	it("should format failure with file path and ancestors", () => {
		expect.assertions(1);

		const test: TestCaseResult = {
			ancestorTitles: ["Math", "Addition"],
			duration: 5,
			failureMessages: ["Expected: 5\nReceived: 4"],
			fullName: "Math Addition should add",
			status: "failed",
			title: "should add",
		};

		const formatted = formatFailure({ filePath: "test.spec.ts", test });

		expect(formatted).toContain("test.spec.ts > Math > Addition > should add");
	});

	it("should render snapshot diff with unified format", () => {
		expect.assertions(3);

		const test: TestCaseResult = {
			ancestorTitles: ["trait data"],
			duration: 12,
			failureMessages: [
				[
					"expect(received).toMatchSnapshot()",
					"",
					"- Snapshot  - 1",
					"+ Received  + 1",
					"",
					'-   "health": 100,',
					'+   "health": 150,',
					"",
					'[string "ReplicatedStorage.traits.spec"]:41',
				].join("\n"),
			],
			fullName: "trait data Apex matches snapshot",
			status: "failed",
			title: "Apex matches snapshot",
		};

		const formatted = formatFailure({
			filePath: "src/traits.spec.ts",
			test,
			useColor: false,
		});

		expect(formatted).toContain("- Snapshot  - 1");
		expect(formatted).toContain("+ Received  + 1");
		expect(formatted).toContain('-   "health": 100,');
	});

	it("should not include mapped source location inside snapshot diff", () => {
		expect.assertions(3);

		const sourceContent = Array.from({ length: 31 }, (_, index) => `line ${index + 1}`);
		sourceContent[28] = "expect(player).toMatchSnapshot();";

		const sourceMapper = fromPartial<SourceMapper>({
			mapFailureMessage: (message: string) => message,
			mapFailureWithLocations: () => {
				return {
					locations: [
						{
							luauLine: 41,
							luauPath: "out/traits.spec.luau",
							sourceContent: sourceContent.join("\n"),
							tsColumn: 16,
							tsLine: 29,
							tsPath: "src/traits.spec.ts",
						},
					],
					message: [
						"expect(received).toMatchSnapshot()",
						"",
						"- Snapshot - 1",
						"+ Received + 1",
						"",
						'- "health": 100,',
						'+ "health": 150,',
						"",
						"src/traits.spec.ts:29",
					].join("\n"),
				};
			},
		});

		const test: TestCaseResult = {
			ancestorTitles: ["trait data"],
			duration: 12,
			failureMessages: [
				[
					"expect(received).toMatchSnapshot()",
					"",
					"- Snapshot  - 1",
					"+ Received  + 1",
					"",
					'-   "health": 100,',
					'+   "health": 150,',
					"",
					'[string "ReplicatedStorage.traits.spec"]:41',
				].join("\n"),
			],
			fullName: "trait data Apex matches snapshot",
			status: "failed",
			title: "Apex matches snapshot",
		};

		const formatted = formatFailure({ sourceMapper, test, useColor: false });

		expect(formatted).toContain("❯ src/traits.spec.ts:29:16");
		expect(formatted).toContain("- Snapshot  - 1");
		expect(formatted.match(/src\/traits\.spec\.ts:29/g)?.length).toBe(1);
	});

	it("should show Luau snippet for Luau-only mapped location", () => {
		expect.assertions(3);

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "fmt-test-"));
		const luauFile = path.join(temporaryDirectory, "test.spec.luau");
		fs.writeFileSync(luauFile, "line1\nline2\nline3\nline4\nexpect(x).toBe(1)\nline6");

		try {
			const luauOnlyResult = {
				locations: [{ luauLine: 5, luauPath: luauFile }],
				message: `${luauFile}:5`,
			};
			const sourceMapper = fromPartial<SourceMapper>({
				mapFailureWithLocations: () => luauOnlyResult,
			});

			const test: TestCaseResult = {
				ancestorTitles: ["Suite"],
				duration: 10,
				failureMessages: ["Expected: 1\nReceived: 2"],
				fullName: "Suite should work",
				status: "failed",
				title: "should work",
			};

			const formatted = formatFailure({
				sourceMapper,
				test,
				useColor: false,
			});

			expect(formatted).toContain(`❯ ${luauFile}:5`);
			expect(formatted).not.toContain("(TypeScript)");
			expect(formatted).not.toContain("(Luau)");
		} finally {
			fs.rmSync(temporaryDirectory, { force: true, recursive: true });
		}
	});

	it("should format multiple failure messages", () => {
		expect.assertions(2);

		const test: TestCaseResult = {
			ancestorTitles: [],
			duration: undefined,
			failureMessages: ["Error 1", "Error 2"],
			fullName: "test",
			status: "failed",
			title: "test",
		};

		const formatted = formatFailure({ test });

		expect(formatted).toContain("Error 1");
		expect(formatted).toContain("Error 2");
	});
});

describe(formatResult, () => {
	it("should format passing file result with check symbol", () => {
		expect.assertions(2);

		const fileResult: TestFileResult = {
			numFailingTests: 0,
			numPassingTests: 3,
			numPendingTests: 0,
			testFilePath: "src/utils.spec.ts",
			testResults: [],
		};

		const result: JestResult = {
			numFailedTests: 0,
			numPassedTests: 3,
			numPendingTests: 0,
			numTotalTests: 3,
			startTime: 0,
			success: true,
			testResults: [fileResult],
		};

		const formatted = formatResult(result, createTiming(1000), defaultOptions);

		expect(formatted).toContain("✓");
		expect(formatted).toContain("utils.spec.ts");
	});

	it("should format failing file result with vitest-style header", () => {
		expect.assertions(4);

		const fileResult: TestFileResult = {
			numFailingTests: 1,
			numPassingTests: 1,
			numPendingTests: 0,
			testFilePath: "src/player.spec.ts",
			testResults: [
				{
					ancestorTitles: ["Player"],
					duration: 10,
					failureMessages: [],
					fullName: "Player should spawn",
					status: "passed",
					title: "should spawn",
				},
				{
					ancestorTitles: ["Player"],
					duration: 5,
					failureMessages: ["Expected: 100\nReceived: 0"],
					fullName: "Player should have health",
					status: "failed",
					title: "should have health",
				},
			],
		};

		const result: JestResult = {
			numFailedTests: 1,
			numPassedTests: 1,
			numPendingTests: 0,
			numTotalTests: 2,
			startTime: 0,
			success: false,
			testResults: [fileResult],
		};

		const formatted = formatResult(result, createTiming(1000), defaultOptions);

		expect(formatted).toContain("Failed Tests 1");
		expect(formatted).toContain("FAIL");
		expect(formatted).toContain("src/player.spec.ts > Player > should have health");
		expect(formatted).toContain("[1/1]");
	});

	it("should show individual tests when verbose", () => {
		expect.assertions(2);

		const fileResult: TestFileResult = {
			numFailingTests: 0,
			numPassingTests: 2,
			numPendingTests: 0,
			testFilePath: "src/utils.spec.ts",
			testResults: [
				{
					ancestorTitles: ["Utils"],
					duration: 5,
					failureMessages: [],
					fullName: "Utils add works",
					status: "passed",
					title: "add works",
				},
				{
					ancestorTitles: ["Utils"],
					duration: 3,
					failureMessages: [],
					fullName: "Utils sub works",
					status: "passed",
					title: "sub works",
				},
			],
		};

		const result: JestResult = {
			numFailedTests: 0,
			numPassedTests: 2,
			numPendingTests: 0,
			numTotalTests: 2,
			startTime: 0,
			success: true,
			testResults: [fileResult],
		};

		const formatted = formatResult(result, createTiming(1000), {
			...defaultOptions,
			verbose: true,
		});

		expect(formatted).toContain("✓ Utils add works");
		expect(formatted).toContain("✓ Utils sub works");
	});

	it("should strip ANSI codes when color is false", () => {
		expect.assertions(2);

		const fileResult: TestFileResult = {
			numFailingTests: 0,
			numPassingTests: 1,
			numPendingTests: 0,
			testFilePath: "test.spec.ts",
			testResults: [],
		};

		const result: JestResult = {
			numFailedTests: 0,
			numPassedTests: 1,
			numPendingTests: 0,
			numTotalTests: 1,
			startTime: 0,
			success: true,
			testResults: [fileResult],
		};

		const formatted = formatResult(result, createTiming(1000), {
			...defaultOptions,
			color: false,
		});

		expect(stripVTControlCharacters(formatted)).toBe(formatted);
		expect(formatted).toContain("✓");
	});

	it("should format directory path with dim style", () => {
		expect.assertions(2);

		const fileResult: TestFileResult = {
			numFailingTests: 0,
			numPassingTests: 1,
			numPendingTests: 0,
			testFilePath: "src/components/Button.spec.ts",
			testResults: [],
		};

		const result: JestResult = {
			numFailedTests: 0,
			numPassedTests: 1,
			numPendingTests: 0,
			numTotalTests: 1,
			startTime: 0,
			success: true,
			testResults: [fileResult],
		};

		const formatted = formatResult(result, createTiming(1000), {
			...defaultOptions,
			color: false,
		});

		expect(formatted).toContain("src/components/");
		expect(formatted).toContain("Button.spec.ts");
	});
});

describe("formatResult failuresOnly", () => {
	const baseOptions: FormatOptions = {
		color: false,
		failuresOnly: true,
		rootDir: "/project",
		verbose: false,
		version: "1.0.0",
	};

	it("should omit passing file summaries in mixed results", () => {
		expect.assertions(2);

		const output = formatResult(MIXED_RESULT, TIMING, baseOptions);

		expect(output).not.toContain("utils.spec.ts");
		expect(output).toContain("game.spec.ts");
	});

	it("should still show failing file with describe groups", () => {
		expect.assertions(3);

		const output = formatResult(MIXED_RESULT, TIMING, baseOptions);

		expect(output).toContain("❯ src/game.spec.ts");
		expect(output).toContain("should end");
		expect(output).toContain("Failed Tests");
	});

	it("should still show summary footer", () => {
		expect.assertions(2);

		const output = formatResult(MIXED_RESULT, TIMING, baseOptions);

		expect(output).toContain("Test Files");
		expect(output).toContain("Tests");
	});

	it("should show no file summaries when all tests pass", () => {
		expect.assertions(2);

		const output = formatResult(PASSING_RESULT, TIMING, baseOptions);

		expect(output).not.toContain("utils.spec.ts");
		expect(output).toContain("Test Files");
	});
});

describe("formatResult log hints", () => {
	it("should show output file hint on failure", () => {
		expect.assertions(1);

		const output = formatResult(FAILING_RESULT, TIMING, {
			...defaultOptions,
			color: false,
			outputFile: "/tmp/results.json",
		});

		expect(output).toContain("View /tmp/results.json for full Jest output");
	});

	it("should show game output hint on failure", () => {
		expect.assertions(1);

		const output = formatResult(FAILING_RESULT, TIMING, {
			...defaultOptions,
			color: false,
			gameOutput: "/tmp/game.json",
		});

		expect(output).toContain("View /tmp/game.json for Roblox game logs");
	});

	it("should show both hints when both paths configured", () => {
		expect.assertions(2);

		const output = formatResult(FAILING_RESULT, TIMING, {
			...defaultOptions,
			color: false,
			gameOutput: "/tmp/game.json",
			outputFile: "/tmp/results.json",
		});

		expect(output).toContain("View /tmp/results.json for full Jest output");
		expect(output).toContain("View /tmp/game.json for Roblox game logs");
	});

	it("should not show hints on passing results", () => {
		expect.assertions(2);

		const output = formatResult(PASSING_RESULT, TIMING, {
			...defaultOptions,
			color: false,
			gameOutput: "/tmp/game.json",
			outputFile: "/tmp/results.json",
		});

		expect(output).not.toContain("View /tmp/results.json");
		expect(output).not.toContain("View /tmp/game.json");
	});

	it("should not show hints when no paths configured", () => {
		expect.assertions(2);

		const output = formatResult(FAILING_RESULT, TIMING, {
			...defaultOptions,
			color: false,
		});

		expect(output).not.toContain("View");
		expect(output).not.toContain("for full Jest output");
	});
});

describe("formatResult snapshots", () => {
	const baseOptions: FormatOptions = {
		color: false,
		rootDir: "/project",
		verbose: false,
		version: "1.0.0",
	};

	it("should format passing results", () => {
		expect.assertions(1);

		const output = formatResult(PASSING_RESULT, TIMING, baseOptions);

		expect(output).toMatchInlineSnapshot(`
			"
			 RUN  v1.0.0 /project

			 ✓ src/utils.spec.ts (3 tests - 30ms)

			 Test Files  1 passed (1)
			      Tests  3 passed (3)
			   Start at  22:13:20
			   Duration  250ms (upload 50ms, environment 50ms, tests 100ms, cli 50ms)"
		`);
	});

	it("should format failing results", () => {
		expect.assertions(1);

		const output = formatResult(FAILING_RESULT, TIMING, baseOptions);

		expect(output).toMatchInlineSnapshot(`
			"
			 RUN  v1.0.0 /project

			 ❯ src/player.spec.ts (3 tests | 2 failed)
			   ❯ Player (3 tests | 2 failed) 18ms
			     ✓ should spawn 10ms
			     × should have health 5ms
			     × should be alive 3ms

			[31m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[39m[41m[37m[1m Failed Tests 2 [22m[39m[49m[31m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[39m
			  
			   FAIL  src/player.spec.ts > Player > should have health
			  expect(received).toBe(expected)
			  
			  - Expected
			  + Received
			  
			  - 100
			  + 0
			  
			  ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯
			  
			   FAIL  src/player.spec.ts > Player > should be alive
			  expect(received).toBe(expected)
			  
			  - Expected
			  + Received
			  
			  - true
			  + false
			  
			  ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯

			 Test Files  1 failed (1)
			      Tests  1 passed | 2 failed (3)
			   Start at  22:13:20
			   Duration  250ms (upload 50ms, environment 50ms, tests 100ms, cli 50ms)"
		`);
	});

	it("should format mixed results", () => {
		expect.assertions(1);

		const output = formatResult(MIXED_RESULT, TIMING, baseOptions);

		expect(output).toMatchInlineSnapshot(`
			"
			 RUN  v1.0.0 /project

			 ✓ src/utils.spec.ts (2 tests - 20ms)
			 ❯ src/game.spec.ts (4 tests | 1 failed)
			   ❯ Game (4 tests | 1 failed) 38ms
			     ✓ should start 10ms
			     ✓ should pause 10ms
			     × should end 8ms
			     × should restart 10ms

			[31m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[39m[41m[37m[1m Failed Tests 1 [22m[39m[49m[31m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[39m
			  
			   FAIL  src/game.spec.ts > Game > should end
			  expect(received).toBe(expected)
			  
			  - Expected
			  + Received
			  
			  - "ended"
			  + "running"
			  
			  ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

			 Test Files  1 passed | 1 failed (2)
			      Tests  4 passed | 1 failed | 1 skipped (6)
			   Start at  22:13:20
			   Duration  250ms (upload 50ms, environment 50ms, tests 100ms, cli 50ms)"
		`);
	});

	it("should format skipped file results", () => {
		expect.assertions(1);

		const output = formatResult(SKIPPED_RESULT, TIMING, baseOptions);

		expect(output).toMatchInlineSnapshot(`
			"
			 RUN  v1.0.0 /project

			 ✓ src/codes.spec.ts (5 tests - 50ms)
			 ↓ src/utils.spec.ts (4 tests)
			 ↓ src/player.spec.ts (3 tests)

			 Test Files  1 passed | 2 skipped (3)
			      Tests  5 passed | 7 skipped (12)
			   Start at  22:13:20
			   Duration  250ms (upload 50ms, environment 50ms, tests 100ms, cli 50ms)"
		`);
	});

	it("should render snapshot failure in full output", () => {
		expect.assertions(4);

		const output = formatResult(SNAPSHOT_FAILING_RESULT, TIMING, baseOptions);

		expect(output).toContain("- Snapshot  - 2");
		expect(output).toContain("+ Received  + 2");
		expect(output).toContain('-   "health": 100,');
		expect(output).toContain('+   "health": 150,');
	});

	it("should format without upload when timing has no upload", () => {
		expect.assertions(1);

		const output = formatResult(PASSING_RESULT, TIMING_NO_UPLOAD, baseOptions);

		expect(output).toMatchInlineSnapshot(`
			"
			 RUN  v1.0.0 /project

			 ✓ src/utils.spec.ts (3 tests - 30ms)

			 Test Files  1 passed (1)
			      Tests  3 passed (3)
			   Start at  22:13:20
			   Duration  200ms (environment 50ms, tests 100ms, cli 50ms)"
		`);
	});

	it("should format with verbose mode", () => {
		expect.assertions(1);

		const output = formatResult(PASSING_RESULT, TIMING, { ...baseOptions, verbose: true });

		expect(output).toMatchInlineSnapshot(`
			"
			 RUN  v1.0.0 /project

			 ✓ src/utils.spec.ts (3 tests - 30ms)
			  ✓ Utils add works 10ms
			  ✓ Utils sub works 10ms
			  ✓ Utils mul works 10ms

			 Test Files  1 passed (1)
			      Tests  3 passed (3)
			   Start at  22:13:20
			   Duration  250ms (upload 50ms, environment 50ms, tests 100ms, cli 50ms)"
		`);
	});

	it("should format with coverage enabled", () => {
		expect.assertions(1);

		const output = formatResult(PASSING_RESULT, TIMING, {
			...baseOptions,
			collectCoverage: true,
		});

		expect(output).toMatchInlineSnapshot(`
			"
			 RUN  v1.0.0 /project
			      Coverage enabled with istanbul

			 ✓ src/utils.spec.ts (3 tests - 30ms)

			 Test Files  1 passed (1)
			      Tests  3 passed (3)
			   Start at  22:13:20
			   Duration  250ms (upload 50ms, environment 50ms, tests 100ms, cli 50ms)"
		`);
	});

	it("should format with coverage enabled and verbose mode", () => {
		expect.assertions(1);

		const output = formatResult(PASSING_RESULT, TIMING, {
			...baseOptions,
			collectCoverage: true,
			verbose: true,
		});

		expect(output).toMatchInlineSnapshot(`
			"
			 RUN  v1.0.0 /project
			      Coverage enabled with istanbul

			 ✓ src/utils.spec.ts (3 tests - 30ms)
			  ✓ Utils add works 10ms
			  ✓ Utils sub works 10ms
			  ✓ Utils mul works 10ms

			 Test Files  1 passed (1)
			      Tests  3 passed (3)
			   Start at  22:13:20
			   Duration  250ms (upload 50ms, environment 50ms, tests 100ms, cli 50ms)"
		`);
	});
});

describe(cleanExecErrorMessage, () => {
	it("should extract error from Jest failureMessage with path chain", () => {
		expect.assertions(1);

		const raw =
			"  \u25cf Test suite failed to run\n\n    ReplicatedStorage.rbxts_include.node_modules.@rbxts-js.JestRuntime:1183: ReplicatedStorage.rbxts_include.node_modules.@rbxts-js.JestRuntime:1951: Require-by-string is not enabled for use inside Jest at this time.\n\n      ReplicatedStorage.rbxts_include.node_modules.@rbxts-js.JestRuntime:1183 function requireModule\n";

		expect(cleanExecErrorMessage(raw)).toBe(
			"Require-by-string is not enabled for use inside Jest at this time.",
		);
	});

	it("should extract error from simple failureMessage", () => {
		expect.assertions(1);

		const raw =
			"  \u25cf Test suite failed to run\n\n    Require-by-string is not enabled for use inside Jest at this time.\n";

		expect(cleanExecErrorMessage(raw)).toBe(
			"Require-by-string is not enabled for use inside Jest at this time.",
		);
	});

	it("should return trimmed message when no pattern matches", () => {
		expect.assertions(1);

		expect(cleanExecErrorMessage("Some unexpected error")).toBe("Some unexpected error");
	});

	it("should handle empty string", () => {
		expect.assertions(1);

		expect(cleanExecErrorMessage("")).toBe("");
	});
});

describe("formatTestSummary exec errors", () => {
	it("should count exec-error files as failed, not skipped", () => {
		expect.assertions(3);

		const summary = formatTestSummary(EXEC_ERROR_RESULT, createTiming(1000));

		expect(summary).toContain("1 failed");
		expect(summary).not.toContain("skipped");
		expect(summary).toContain("(1)");
	});

	it("should count exec-error files alongside passing files", () => {
		expect.assertions(3);

		const summary = formatTestSummary(MIXED_WITH_EXEC_ERROR_RESULT, createTiming(1000));

		expect(summary).toContain("1 passed");
		expect(summary).toContain("1 failed");
		expect(summary).toContain("(2)");
	});
});

describe("formatResult exec errors", () => {
	it("should show exec-error file with fail symbol and error message", () => {
		expect.assertions(3);

		const output = formatResult(EXEC_ERROR_RESULT, TIMING, {
			...defaultOptions,
			color: false,
		});

		expect(output).toContain("unit-menu-app.test");
		expect(output).toContain("Require-by-string is not enabled");
		// Must not show "↓" (skipped symbol)
		expect(output).not.toContain("\u2193");
	});

	it("should show exec-error in detailed failures section", () => {
		expect.assertions(2);

		const output = formatResult(EXEC_ERROR_RESULT, TIMING, {
			...defaultOptions,
			color: false,
		});

		expect(output).toContain("Failed Tests");
		expect(output).toContain("Require-by-string is not enabled");
	});

	it("should show log hints for exec-error results", () => {
		expect.assertions(1);

		const output = formatResult(EXEC_ERROR_RESULT, TIMING, {
			...defaultOptions,
			color: false,
			outputFile: "/tmp/results.json",
		});

		expect(output).toContain("View /tmp/results.json for full Jest output");
	});
});

describe("formatResult exec error snapshots", () => {
	const baseOptions: FormatOptions = {
		color: false,
		rootDir: "/project",
		verbose: false,
		version: "1.0.0",
	};

	it("should format exec-error-only result", () => {
		expect.assertions(1);

		const output = formatResult(EXEC_ERROR_RESULT, TIMING, baseOptions);

		expect(output).toMatchInlineSnapshot(`
			"
			 RUN  v1.0.0 /project

			 ✗ shared/react/features/windows/__tests__/unit-menu-app.test
			   Require-by-string is not enabled for use inside Jest at this time.

			[31m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[39m[41m[37m[1m Failed Tests 1 [22m[39m[49m[31m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[39m
			   FAIL  shared/react/features/windows/__tests__/unit-menu-app.test
			  Test suite failed to run

			  Require-by-string is not enabled for use inside Jest at this time.

			  ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

			 Test Files  1 failed (1)
			      Tests   (0)
			   Start at  22:13:20
			   Duration  250ms (upload 50ms, environment 50ms, tests 100ms, cli 50ms)"
		`);
	});

	it("should format mixed passing + exec-error result", () => {
		expect.assertions(1);

		const output = formatResult(MIXED_WITH_EXEC_ERROR_RESULT, TIMING, baseOptions);

		expect(output).toMatchInlineSnapshot(`
			"
			 RUN  v1.0.0 /project

			 ✓ src/utils.spec.ts (3 tests - 30ms)
			 ✗ src/broken.spec.ts
			   Require-by-string is not enabled for use inside Jest at this time.

			[31m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[39m[41m[37m[1m Failed Tests 1 [22m[39m[49m[31m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[39m
			   FAIL  src/broken.spec.ts
			  Test suite failed to run

			  Require-by-string is not enabled for use inside Jest at this time.

			  ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

			 Test Files  1 passed | 1 failed (2)
			      Tests  3 passed (3)
			   Start at  22:13:20
			   Duration  250ms (upload 50ms, environment 50ms, tests 100ms, cli 50ms)"
		`);
	});
});

describe("formatResult with typecheck data", () => {
	const baseOptions: FormatOptions = {
		color: false,
		rootDir: "/project",
		verbose: false,
		version: "1.0.0",
	};

	it("should format passing typecheck result", () => {
		expect.assertions(1);

		const output = formatResult(TYPECHECK_PASSING_RESULT, TIMING_NO_UPLOAD, baseOptions);

		expect(output).toMatchInlineSnapshot(`
			"
			 RUN  v1.0.0 /project

			 ✓ src/types.test-d.ts (2 tests)

			 Test Files  1 passed (1)
			      Tests  2 passed (2)
			   Start at  22:13:20
			   Duration  200ms (environment 50ms, tests 100ms, cli 50ms)"
		`);
	});

	it("should format failing typecheck result", () => {
		expect.assertions(1);

		const output = formatResult(TYPECHECK_FAILING_RESULT, TIMING_NO_UPLOAD, baseOptions);

		expect(output).toMatchInlineSnapshot(`
			"
			 RUN  v1.0.0 /project

			 ❯ src/types.test-d.ts (2 tests | 1 failed)
			   ❯ type checks (2 tests | 1 failed) 0ms
			     × should reject string as number
			     ✓ should accept number

			[31m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[39m[41m[37m[1m Failed Tests 1 [22m[39m[49m[31m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[39m
			  
			   FAIL  src/types.test-d.ts > type checks > should reject string as number
			  TS2322: Type 'string' is not assignable to type 'number'.
			  
			  ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

			 Test Files  1 failed (1)
			      Tests  1 passed | 1 failed (2)
			   Start at  22:13:20
			   Duration  200ms (environment 50ms, tests 100ms, cli 50ms)"
		`);
	});

	it("should format mixed typecheck result", () => {
		expect.assertions(1);

		const output = formatResult(TYPECHECK_MIXED_RESULT, TIMING_NO_UPLOAD, baseOptions);

		expect(output).toMatchInlineSnapshot(`
			"
			 RUN  v1.0.0 /project

			 ✓ src/passing.test-d.ts (2 tests)
			 ❯ src/failing.test-d.ts (2 tests | 1 failed)
			   ❯ failing types (2 tests | 1 failed) 0ms
			     × should reject string as number
			     ✓ should pass this one

			[31m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[39m[41m[37m[1m Failed Tests 1 [22m[39m[49m[31m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[39m
			  
			   FAIL  src/failing.test-d.ts > failing types > should reject string as number
			  TS2322: Type 'string' is not assignable to type 'number'.
			  
			  ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

			 Test Files  1 passed | 1 failed (2)
			      Tests  3 passed | 1 failed (4)
			   Start at  22:13:20
			   Duration  200ms (environment 50ms, tests 100ms, cli 50ms)"
		`);
	});
});

describe("formatTestSummary type errors line", () => {
	it("should show 'no errors' when typeErrors is 0", () => {
		expect.assertions(1);

		const output = formatTestSummary(PASSING_RESULT, TIMING_NO_UPLOAD, undefined, {
			typeErrors: 0,
		});
		const plain = stripVTControlCharacters(output);

		expect(plain).toContain("Type Errors  no errors");
	});

	it("should show failed count when typeErrors > 0", () => {
		expect.assertions(1);

		const output = formatTestSummary(PASSING_RESULT, TIMING_NO_UPLOAD, undefined, {
			typeErrors: 3,
		});
		const plain = stripVTControlCharacters(output);

		expect(plain).toContain("Type Errors  3 failed");
	});

	it("should omit type errors line when typeErrors is undefined", () => {
		expect.assertions(1);

		const output = formatTestSummary(PASSING_RESULT, TIMING_NO_UPLOAD);
		const plain = stripVTControlCharacters(output);

		expect(plain).not.toContain("Type Errors");
	});
});

describe("formatTypecheckSummary snapshots", () => {
	it("should format passing typecheck summary", () => {
		expect.assertions(1);

		const output = formatTypecheckSummary(TYPECHECK_PASSING_RESULT, false);

		expect(output).toMatchInlineSnapshot(`
			"
			Type Tests: 2 passed, 2 total
			"
		`);
	});

	it("should format failing typecheck summary with failures", () => {
		expect.assertions(1);

		const output = formatTypecheckSummary(TYPECHECK_FAILING_RESULT, false);

		expect(output).toMatchInlineSnapshot(`
			"   FAIL  type checks > should reject string as number
			    TS2322: Type 'string' is not assignable to type 'number'.

			Type Tests: 1 failed, 1 passed, 2 total
			"
		`);
	});

	it("should format mixed typecheck summary with failure from one file", () => {
		expect.assertions(1);

		const output = formatTypecheckSummary(TYPECHECK_MIXED_RESULT, false);

		expect(output).toMatchInlineSnapshot(`
			"   FAIL  failing types > should reject string as number
			    TS2322: Type 'string' is not assignable to type 'number'.

			Type Tests: 1 failed, 3 passed, 4 total
			"
		`);
	});
});

describe("formatErrorLine bold Error: branch", () => {
	it("should bold 'Error:' prefix when useColor is true and message starts with Error:", () => {
		expect.assertions(2);

		const test: TestCaseResult = {
			ancestorTitles: [],
			duration: 1,
			failureMessages: ["Error: something went wrong"],
			fullName: "test",
			status: "failed",
			title: "test",
		};

		const formatted = formatFailure({ test, useColor: true });
		const plain = stripVTControlCharacters(formatted);

		expect(plain).toContain("Error: something went wrong");
		// With color on, the raw output should differ from stripped (ANSI
		// present)
		expect(formatted).not.toBe(plain);
	});

	it("should not bold when message does not start with Error:", () => {
		expect.assertions(1);

		const test: TestCaseResult = {
			ancestorTitles: [],
			duration: 1,
			failureMessages: ["expect(received).toBe(expected)"],
			fullName: "test",
			status: "failed",
			title: "test",
		};

		const formatted = formatFailure({ test, useColor: false });

		expect(formatted).toContain("expect(received).toBe(expected)");
	});
});

describe("resolveSourceSnippets snapshot-diff fallback", () => {
	it("should attempt snapshot call snippet when snapshot diff present and no mapped locations", () => {
		expect.assertions(2);

		const snapshotMessage = [
			"expect(received).toMatchSnapshot()",
			"",
			"- Snapshot  - 1",
			"+ Received  + 1",
			"",
			'-   "health": 100,',
			'+   "health": 150,',
			"",
			'[string "ReplicatedStorage.traits.spec"]:41',
		].join("\n");

		const test: TestCaseResult = {
			ancestorTitles: ["suite"],
			duration: 5,
			failureMessages: [snapshotMessage],
			fullName: "suite snap test",
			status: "failed",
			title: "snap test",
		};

		// filePath provided but nonexistent, no sourceMapper — exercises the
		// hasSnapshotDiff && filePath !== undefined fallback
		// (formatSnapshotCallSnippet returns [] because file doesn't exist)
		const formatted = formatFailure({
			filePath: "nonexistent/path.spec.ts",
			test,
			useColor: false,
		});

		expect(formatted).toContain("- Snapshot  - 1");
		// No source snippet should appear (file doesn't exist)
		expect(formatted).not.toContain("❯");
	});

	it("should use sourceMapper.resolveTestFilePath for snapshot call snippet lookup", () => {
		expect.assertions(1);

		const resolveTestFilePath = vi
			.fn<(p: string) => string>()
			.mockReturnValue("also-nonexistent.spec.ts");
		const sourceMapper = fromPartial<SourceMapper>({
			mapFailureWithLocations: (message: string) => ({ locations: [], message }),
			resolveTestFilePath,
		});

		const snapshotMessage = [
			"expect(received).toMatchSnapshot()",
			"",
			"- Snapshot  - 1",
			"+ Received  + 1",
			"",
			'-   "x": 1,',
			'+   "x": 2,',
			"",
			'[string "RS.test"]:10',
		].join("\n");

		const test: TestCaseResult = {
			ancestorTitles: [],
			duration: 1,
			failureMessages: [snapshotMessage],
			fullName: "test",
			status: "failed",
			title: "test",
		};

		formatFailure({
			filePath: "src/test.spec.ts",
			sourceMapper,
			test,
			useColor: false,
		});

		expect(resolveTestFilePath).toHaveBeenCalledWith("src/test.spec.ts");
	});
});

describe("formatDescribeGroup all-passing else branch", () => {
	it("should render all-passing describe group with check mark and color", () => {
		expect.assertions(3);

		const fileResult: TestFileResult = {
			numFailingTests: 1,
			numPassingTests: 2,
			numPendingTests: 0,
			testFilePath: "src/math.spec.ts",
			testResults: [
				{
					ancestorTitles: ["Passing"],
					duration: 5,
					failureMessages: [],
					fullName: "Passing add works",
					status: "passed",
					title: "add works",
				},
				{
					ancestorTitles: ["Passing"],
					duration: 3,
					failureMessages: [],
					fullName: "Passing sub works",
					status: "passed",
					title: "sub works",
				},
				{
					ancestorTitles: ["Failing"],
					duration: 2,
					failureMessages: ["Expected: 1\nReceived: 2"],
					fullName: "Failing breaks",
					status: "failed",
					title: "breaks",
				},
			],
		};

		const result: JestResult = {
			numFailedTests: 1,
			numPassedTests: 2,
			numPendingTests: 0,
			numTotalTests: 3,
			startTime: 0,
			success: false,
			testResults: [fileResult],
		};

		// color: true exercises the colored else-branch of formatDescribeGroup
		const formatted = formatResult(result, createTiming(1000), {
			...defaultOptions,
			color: true,
		});
		const plain = stripVTControlCharacters(formatted);

		// The all-passing "Passing" group should render with ✓ marker
		expect(plain).toContain("✓ Passing");
		expect(plain).toContain("(2 tests)");
		// The failing group should still render with ❯
		expect(plain).toContain("❯ Failing");
	});
});

describe("formatFilePath bare filename", () => {
	it("should render just the filename when path has no directory", () => {
		expect.assertions(2);

		const fileResult: TestFileResult = {
			numFailingTests: 0,
			numPassingTests: 1,
			numPendingTests: 0,
			testFilePath: "test.spec.ts",
			testResults: [],
		};

		const result: JestResult = {
			numFailedTests: 0,
			numPassedTests: 1,
			numPendingTests: 0,
			numTotalTests: 1,
			startTime: 0,
			success: true,
			testResults: [fileResult],
		};

		const formatted = formatResult(result, createTiming(500), {
			...defaultOptions,
			color: false,
		});

		expect(formatted).toContain("test.spec.ts");
		// No directory separator before filename
		expect(formatted).not.toContain("/test.spec.ts");
	});
});

describe("formatTestInGroup duration undefined", () => {
	it("should render passed test without duration suffix when duration is undefined", () => {
		expect.assertions(2);

		const fileResult: TestFileResult = {
			numFailingTests: 1,
			numPassingTests: 1,
			numPendingTests: 0,
			testFilePath: "src/dur.spec.ts",
			testResults: [
				{
					ancestorTitles: ["Suite"],
					duration: undefined,
					failureMessages: [],
					fullName: "Suite no-dur passes",
					status: "passed",
					title: "no-dur passes",
				},
				{
					ancestorTitles: ["Suite"],
					duration: undefined,
					failureMessages: ["Expected: 1\nReceived: 2"],
					fullName: "Suite no-dur fails",
					status: "failed",
					title: "no-dur fails",
				},
			],
		};

		const result: JestResult = {
			numFailedTests: 1,
			numPassedTests: 1,
			numPendingTests: 0,
			numTotalTests: 2,
			startTime: 0,
			success: false,
			testResults: [fileResult],
		};

		const formatted = formatResult(result, createTiming(500), {
			...defaultOptions,
			color: false,
		});
		const plain = stripVTControlCharacters(formatted);

		// The passed test line should end with the title, no "ms" suffix
		expect(plain).toContain("✓ no-dur passes");
		expect(plain).toContain("× no-dur fails");
	});
});

describe("formatTestSummary upload cached", () => {
	it("should show (cached) suffix when upload was cached", () => {
		expect.assertions(1);

		const summary = formatTestSummary(PASSING_RESULT, {
			...TIMING,
			uploadCached: true,
		});
		const plain = stripVTControlCharacters(summary);

		expect(plain).toContain("upload 50ms (cached)");
	});
});

describe("formatTestSummary coverage timing", () => {
	it("should show coverage bucket when coverageMs is provided", () => {
		expect.assertions(2);

		const summary = formatTestSummary(PASSING_RESULT, TIMING_COVERAGE);
		const plain = stripVTControlCharacters(summary);

		expect(plain).toContain("coverage 3000ms");
		expect(plain).toContain("Duration  3250ms");
	});

	it("should subtract coverageMs from cli bucket", () => {
		expect.assertions(1);

		const summary = formatTestSummary(PASSING_RESULT, TIMING_COVERAGE);
		const plain = stripVTControlCharacters(summary);

		// totalMs=3250, uploadMs=50, executionMs=150, coverageMs=3000 → cli=50
		expect(plain).toContain("cli 50ms");
	});

	it("should omit coverage bucket when coverageMs is undefined", () => {
		expect.assertions(1);

		const summary = formatTestSummary(PASSING_RESULT, TIMING);
		const plain = stripVTControlCharacters(summary);

		expect(plain).not.toContain("coverage");
	});

	it("should omit coverage bucket when coverageMs is zero", () => {
		expect.assertions(1);

		const summary = formatTestSummary(PASSING_RESULT, { ...TIMING, coverageMs: 0 });
		const plain = stripVTControlCharacters(summary);

		expect(plain).not.toContain("coverage");
	});
});

describe("formatTestSummary setup timing", () => {
	it("should show setup bucket when setupMs is provided", () => {
		expect.assertions(1);

		const summary = formatTestSummary(PASSING_RESULT, {
			...TIMING,
			executionMs: 500,
			setupMs: 200,
			totalMs: 600,
		});
		const plain = stripVTControlCharacters(summary);

		expect(plain).toContain("setup 200ms");
	});

	it("should subtract setupMs from environment bucket", () => {
		expect.assertions(1);

		// executionMs=500, testsMs=100, setupMs=200 → environment=200
		const summary = formatTestSummary(PASSING_RESULT, {
			...TIMING,
			executionMs: 500,
			setupMs: 200,
			totalMs: 600,
		});
		const plain = stripVTControlCharacters(summary);

		expect(plain).toContain("environment 200ms");
	});

	it("should clamp environment to zero when setupMs exceeds available time", () => {
		expect.assertions(1);

		// executionMs=150, testsMs=100, setupMs=200 → would be -150, clamp to 0
		const summary = formatTestSummary(PASSING_RESULT, {
			...TIMING,
			setupMs: 200,
		});
		const plain = stripVTControlCharacters(summary);

		expect(plain).toContain("environment 0ms");
	});

	it("should omit setup bucket when setupMs is undefined", () => {
		expect.assertions(1);

		const summary = formatTestSummary(PASSING_RESULT, TIMING);
		const plain = stripVTControlCharacters(summary);

		expect(plain).not.toContain("setup");
	});

	it("should omit setup bucket when setupMs is zero", () => {
		expect.assertions(1);

		const summary = formatTestSummary(PASSING_RESULT, { ...TIMING, setupMs: 0 });
		const plain = stripVTControlCharacters(summary);

		expect(plain).not.toContain("setup");
	});
});

describe("formatSnapshotCallSnippet via formatFailure", () => {
	function writeTemporary(content: string): string {
		const filePath = path.join(os.tmpdir(), `formatter-test-${Date.now()}.ts`);
		fs.writeFileSync(filePath, content, "utf-8");
		return filePath;
	}

	function makeSnapshotMessage(): string {
		return [
			"expect(received).toMatchSnapshot()",
			"",
			"- Snapshot  - 1",
			"+ Received  + 1",
			"",
			'-   "x": 1,',
			'+   "x": 2,',
			"",
			'[string "RS.test"]:10',
		].join("\n");
	}

	it("should show snapshot call snippet when file exists with exactly one toMatchSnapshot", () => {
		expect.assertions(2);

		const filePath = writeTemporary(
			[
				"import { describe, it, expect } from 'vitest';",
				"",
				"describe('suite', () => {",
				"  it('should match', () => {",
				"    expect(data).toMatchSnapshot();",
				"  });",
				"});",
			].join("\n"),
		);

		try {
			const test: TestCaseResult = {
				ancestorTitles: [],
				duration: 1,
				failureMessages: [makeSnapshotMessage()],
				fullName: "test",
				status: "failed",
				title: "test",
			};

			const formatted = formatFailure({
				filePath,
				test,
				useColor: false,
			});

			expect(formatted).toContain(`❯ ${filePath}:5`);
			expect(formatted).toContain("toMatchSnapshot");
		} finally {
			fs.unlinkSync(filePath);
		}
	});

	it("should not show snippet when file has multiple toMatchSnapshot calls", () => {
		expect.assertions(1);

		const filePath = writeTemporary(
			["expect(a).toMatchSnapshot();", "expect(b).toMatchSnapshot();"].join("\n"),
		);

		try {
			const test: TestCaseResult = {
				ancestorTitles: [],
				duration: 1,
				failureMessages: [makeSnapshotMessage()],
				fullName: "test",
				status: "failed",
				title: "test",
			};

			const formatted = formatFailure({
				filePath,
				test,
				useColor: false,
			});

			// Multiple toMatchSnapshot calls — no snippet shown
			expect(formatted).not.toContain("❯");
		} finally {
			fs.unlinkSync(filePath);
		}
	});
});

describe("showLuau mapped location snippets", () => {
	it("should show both TypeScript and Luau snippets when showLuau is true", () => {
		expect.assertions(3);

		const luauContent = Array.from({ length: 15 }, (_, index) => `-- line ${index + 1}`);
		luauContent[9] = "expect(value).toBe(42)";
		const luauFile = path.join(os.tmpdir(), `formatter-test-${Date.now()}.luau`);
		fs.writeFileSync(luauFile, luauContent.join("\n"), "utf-8");

		try {
			const sourceContent = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`);
			sourceContent[4] = "expect(value).toBe(42);";

			const sourceMapper = fromPartial<SourceMapper>({
				mapFailureWithLocations: () => {
					return {
						locations: [
							{
								luauLine: 10,
								luauPath: luauFile,
								sourceContent: sourceContent.join("\n"),
								tsColumn: 15,
								tsLine: 5,
								tsPath: "src/test.ts",
							},
						],
						message: "Expected: 42\nReceived: 0\n\nsrc/test.ts:5",
					};
				},
			});

			const test: TestCaseResult = {
				ancestorTitles: [],
				duration: 1,
				failureMessages: ["Expected: 42\nReceived: 0"],
				fullName: "test",
				status: "failed",
				title: "test",
			};

			const formatted = formatFailure({
				showLuau: true,
				sourceMapper,
				test,
				useColor: false,
			});

			expect(formatted).toContain("(TypeScript)");
			expect(formatted).toContain("(Luau)");
			expect(formatted).toContain("❯ src/test.ts:5:15");
		} finally {
			fs.unlinkSync(luauFile);
		}
	});
});

describe("formatFallbackSnippet via formatFailure", () => {
	it("should show fallback snippet when message contains a parseable source location", () => {
		expect.assertions(2);

		const fileContent = [
			"import { describe, it, expect } from 'vitest';",
			"",
			"describe('math', () => {",
			"  it('should add', () => {",
			"    expect(1 + 1).toBe(3);",
			"  });",
			"});",
		].join("\n");
		const temporaryFile = path.join("src", "formatters", `__tmp-fallback-${Date.now()}.ts`);
		fs.writeFileSync(temporaryFile, fileContent, "utf-8");

		try {
			const test: TestCaseResult = {
				ancestorTitles: [],
				duration: 1,
				failureMessages: [`LoadModule error: ${temporaryFile}:5:10`],
				fullName: "test",
				status: "failed",
				title: "test",
			};

			const formatted = formatFailure({ test, useColor: false });

			expect(formatted).toContain(`❯ ${temporaryFile}:5:10`);
			expect(formatted).toContain("expect(1 + 1).toBe(3)");
		} finally {
			fs.unlinkSync(temporaryFile);
		}
	});
});

describe("expandTabs via formatSourceSnippet", () => {
	it("should expand tab characters to spaces in source snippet content", () => {
		expect.assertions(3);

		const snippet: SourceSnippet = {
			failureLine: 2,
			lines: [
				{ content: "\tconst a = 1;", num: 1 },
				{ content: "\t\texpect(a).toBe(2);", num: 2 },
			],
		};

		const formatted = formatSourceSnippet(snippet, "file.ts", { useColor: false });

		// Content tabs are expanded to spaces (gutter indent is a literal \t)
		expect(formatted).toContain("    const a = 1;");
		// Two tabs -> 8 spaces (4 + 4)
		expect(formatted).toContain("        expect(a).toBe(2);");
		expect(formatted).toContain("expect(a).toBe(2);");
	});
});

describe("formatFallbackSnippet nonexistent file", () => {
	it("should return no snippet when parseSourceLocation matches but file does not exist", () => {
		expect.assertions(1);

		const test: TestCaseResult = {
			ancestorTitles: [],
			duration: 1,
			failureMessages: ["Error at /nonexistent/path/to/file.ts:10:5"],
			fullName: "test",
			status: "failed",
			title: "test",
		};

		const formatted = formatFailure({ test, useColor: false });

		// parseSourceLocation parses the location but getSourceSnippet returns
		// undefined because the file doesn't exist — no snippet rendered
		expect(formatted).not.toContain("❯");
	});
});

describe("formatMappedLocationSnippets undefined branches", () => {
	it("should skip TS snippet when tsPath points to nonexistent file", () => {
		expect.assertions(2);

		const sourceMapper = fromPartial<SourceMapper>({
			mapFailureWithLocations: () => {
				return {
					locations: [
						{
							luauLine: 5,
							luauPath: "/nonexistent/luau.luau",
							tsLine: 10,
							tsPath: "/nonexistent/source.ts",
						},
					],
					message: "Expected: 1\nReceived: 2",
				};
			},
		});

		const test: TestCaseResult = {
			ancestorTitles: [],
			duration: 1,
			failureMessages: ["Expected: 1\nReceived: 2"],
			fullName: "test",
			status: "failed",
			title: "test",
		};

		const formatted = formatFailure({
			sourceMapper,
			test,
			useColor: false,
		});

		// No snippet rendered for either TS or Luau (both nonexistent)
		expect(formatted).not.toContain("❯");
		expect(formatted).toContain("Expected: 1");
	});

	it("should skip Luau-only snippet when luauPath points to nonexistent file", () => {
		expect.assertions(1);

		const sourceMapper = fromPartial<SourceMapper>({
			mapFailureWithLocations: () => {
				return {
					locations: [{ luauLine: 5, luauPath: "/nonexistent/luau.luau" }],
					message: "Expected: 1\nReceived: 2",
				};
			},
		});

		const test: TestCaseResult = {
			ancestorTitles: [],
			duration: 1,
			failureMessages: ["Expected: 1\nReceived: 2"],
			fullName: "test",
			status: "failed",
			title: "test",
		};

		const formatted = formatFailure({ sourceMapper, test, useColor: false });

		// No snippet rendered — source file nonexistent and no sourceContent
		expect(formatted).not.toContain("❯");
	});

	it("should skip Luau snippet when luauPath points to nonexistent file with showLuau", () => {
		expect.assertions(2);

		const tsContent = Array.from({ length: 10 }, (_, index) => `// line ${index + 1}`);
		tsContent[4] = "expect(x).toBe(1);";

		const sourceMapper = fromPartial<SourceMapper>({
			mapFailureWithLocations: () => {
				return {
					locations: [
						{
							luauLine: 5,
							luauPath: "/nonexistent/luau.luau",
							sourceContent: tsContent.join("\n"),
							tsLine: 5,
							tsPath: "src/real.ts",
						},
					],
					message: "Expected: 1\nReceived: 2",
				};
			},
		});

		const test: TestCaseResult = {
			ancestorTitles: [],
			duration: 1,
			failureMessages: ["Expected: 1\nReceived: 2"],
			fullName: "test",
			status: "failed",
			title: "test",
		};

		const formatted = formatFailure({
			showLuau: true,
			sourceMapper,
			test,
			useColor: false,
		});

		// TS snippet shown (from sourceContent), but Luau snippet skipped
		expect(formatted).toContain("(TypeScript)");
		expect(formatted).not.toContain("(Luau)");
	});
});

describe("formatPass duration undefined", () => {
	it("should render passed test without duration in verbose mode when duration is undefined", () => {
		expect.assertions(2);

		const fileResult: TestFileResult = {
			numFailingTests: 0,
			numPassingTests: 1,
			numPendingTests: 0,
			testFilePath: "src/no-duration.spec.ts",
			testResults: [
				{
					ancestorTitles: ["Suite"],
					duration: undefined,
					failureMessages: [],
					fullName: "Suite should work",
					status: "passed",
					title: "should work",
				},
			],
		};

		const result: JestResult = {
			numFailedTests: 0,
			numPassedTests: 1,
			numPendingTests: 0,
			numTotalTests: 1,
			startTime: 0,
			success: true,
			testResults: [fileResult],
		};

		const formatted = formatResult(result, createTiming(500), {
			...defaultOptions,
			color: false,
			verbose: true,
		});

		expect(formatted).toContain("✓ Suite should work");
		// No "ms" suffix on the verbose pass line
		expect(formatted).not.toMatch(/Suite should work\s+\d+ms/);
	});
});

describe("formatPassedFileSummary with non-passed test", () => {
	it("should skip non-passed tests in verbose passed file summary", () => {
		expect.assertions(3);

		const fileResult: TestFileResult = {
			numFailingTests: 0,
			numPassingTests: 1,
			numPendingTests: 1,
			testFilePath: "src/mixed-pass.spec.ts",
			testResults: [
				{
					ancestorTitles: ["Suite"],
					duration: 5,
					failureMessages: [],
					fullName: "Suite should pass",
					status: "passed",
					title: "should pass",
				},
				{
					ancestorTitles: ["Suite"],
					duration: undefined,
					failureMessages: [],
					fullName: "Suite should be skipped",
					status: "pending",
					title: "should be skipped",
				},
			],
		};

		const result: JestResult = {
			numFailedTests: 0,
			numPassedTests: 1,
			numPendingTests: 1,
			numTotalTests: 2,
			startTime: 0,
			success: true,
			testResults: [fileResult],
		};

		const formatted = formatResult(result, createTiming(500), {
			...defaultOptions,
			color: false,
			verbose: true,
		});

		// Passed test shown in verbose output
		expect(formatted).toContain("✓ Suite should pass");
		// Pending test NOT shown in verbose passed file summary
		expect(formatted).not.toContain("should be skipped");
		// File summary still shows correct counts
		expect(formatted).toContain("(2 tests");
	});
});

describe("groupByDescribe root fallback", () => {
	it("should use (root) as group name when ancestorTitles is empty", () => {
		expect.assertions(1);

		const fileResult: TestFileResult = {
			numFailingTests: 1,
			numPassingTests: 0,
			numPendingTests: 0,
			testFilePath: "src/root.spec.ts",
			testResults: [
				{
					ancestorTitles: [],
					duration: 3,
					failureMessages: ["Expected: 1\nReceived: 2"],
					fullName: "should fail",
					status: "failed",
					title: "should fail",
				},
			],
		};

		const result: JestResult = {
			numFailedTests: 1,
			numPassedTests: 0,
			numPendingTests: 0,
			numTotalTests: 1,
			startTime: 0,
			success: false,
			testResults: [fileResult],
		};

		const formatted = formatResult(result, createTiming(500), {
			...defaultOptions,
			color: false,
		});

		expect(formatted).toContain("(root)");
	});
});

describe("formatSnapshotCallSnippet getSourceSnippet guard via formatFailure", () => {
	it("should return no snippet when getSourceSnippet returns undefined", () => {
		expect.assertions(1);

		const filePath = path.join(os.tmpdir(), `formatter-snap-guard-${Date.now()}.ts`);
		fs.writeFileSync(filePath, "expect(x).toMatchSnapshot();", "utf-8");

		const spy = vi.spyOn(sourceMapperModule, "getSourceSnippet").mockReturnValue(undefined);

		try {
			const test: TestCaseResult = {
				ancestorTitles: [],
				duration: 1,
				failureMessages: [
					[
						"expect(received).toMatchSnapshot()",
						"",
						"- Snapshot  - 1",
						"+ Received  + 1",
						"",
						'-   "a": 1,',
						'+   "a": 2,',
						"",
						'[string "RS.test"]:10',
					].join("\n"),
				],
				fullName: "test",
				status: "failed",
				title: "test",
			};

			const formatted = formatFailure({ filePath, test, useColor: false });

			expect(formatted).not.toContain("❯");
		} finally {
			spy.mockRestore();
			fs.unlinkSync(filePath);
		}
	});
});

describe("formatResult testFilePath resolution", () => {
	it("should resolve DataModel testFilePath to filesystem path when sourceMapper is provided", () => {
		expect.assertions(2);

		const result: JestResult = {
			numFailedTests: 1,
			numPassedTests: 0,
			numPendingTests: 0,
			numTotalTests: 1,
			startTime: 1700000000000,
			success: false,
			testResults: [
				{
					numFailingTests: 1,
					numPassingTests: 0,
					numPendingTests: 0,
					testFilePath: "ReplicatedStorage/client/example/test.spec",
					testResults: [
						{
							ancestorTitles: ["a calculator"],
							duration: 5,
							failureMessages: [
								"expect(received).toBe(expected)\n\nExpected: 4\nReceived: 3",
							],
							fullName: "a calculator should add",
							status: "failed" as const,
							title: "should add",
						},
					],
				},
			],
		};

		const output = stripVTControlCharacters(
			formatResult(result, TIMING, {
				...defaultOptions,
				color: true,
				sourceMapper: fromPartial({
					mapFailureWithLocations: (message: string) => {
						return {
							locations: [],
							message,
						};
					},
					resolveTestFilePath: () => "src/client/example/test.spec.ts",
				}),
			}),
		);

		expect(output).toContain("src/client/example/test.spec.ts");
		expect(output).not.toContain("ReplicatedStorage");
	});
});

describe(getExecErrorHint, () => {
	it("should return hint for loadstring error", () => {
		expect.assertions(1);

		const hint = getExecErrorHint("loadstring() is not available");

		expect(hint).toContain("LoadStringEnabled");
	});

	it("should return undefined for unrecognized errors", () => {
		expect.assertions(1);

		const hint = getExecErrorHint("some other error");

		expect(hint).toBeUndefined();
	});
});

describe("formatResult loadstring hint", () => {
	it("should show hint when loadstring is not available", () => {
		expect.assertions(2);

		const output = formatResult(LOADSTRING_ERROR_RESULT, TIMING, {
			...defaultOptions,
			color: false,
		});

		expect(output).toContain("loadstring() is not available");
		expect(output).toContain("LoadStringEnabled");
	});
});

// --- Multi-project output ---

describe(formatProjectHeader, () => {
	it("should show project name with pass count and test total", () => {
		expect.assertions(4);

		const output = formatProjectHeader({ displayName: "core", result: PASSING_RESULT });
		const plain = stripVTControlCharacters(output);

		expect(plain).toContain("▶  core ");
		expect(plain).toContain("1 passed");
		expect(plain).toContain("3 tests");
		expect(plain).not.toContain("failed");
	});

	it("should show failed file count when tests fail", () => {
		expect.assertions(2);

		const output = formatProjectHeader({ displayName: "auth", result: FAILING_RESULT });
		const plain = stripVTControlCharacters(output);

		expect(plain).toContain("1 failed");
		expect(plain).toContain("3 tests");
	});

	it("should show skipped count for skip-only files", () => {
		expect.assertions(3);

		const output = formatProjectHeader({ displayName: "utils", result: SKIPPED_RESULT });
		const plain = stripVTControlCharacters(output);

		expect(plain).toContain("1 passed");
		expect(plain).toContain("2 skipped");
		expect(plain).toContain("12 tests");
	});

	it("should include duration when tests have timing", () => {
		expect.assertions(1);

		const output = formatProjectHeader({ displayName: "core", result: PASSING_RESULT });
		const plain = stripVTControlCharacters(output);

		expect(plain).toMatch(/\d+ms/);
	});
});

describe(formatProjectSection, () => {
	const noColorOptions: FormatOptions = { ...defaultOptions, color: false };
	const failureCtx = { currentIndex: 1, totalFailures: 0 };

	it("should show header followed by file summaries", () => {
		expect.assertions(3);

		const output = formatProjectSection({
			displayName: "core",
			failureCtx,
			options: noColorOptions,
			result: PASSING_RESULT,
		});

		expect(output).toContain("▶ core");
		expect(output).toContain("utils.spec.ts");
		expect(output).toContain("✓");
	});

	it("should include failure details for failing tests", () => {
		expect.assertions(2);

		const ctx = { currentIndex: 1, totalFailures: 2 };
		const output = formatProjectSection({
			displayName: "auth",
			failureCtx: ctx,
			options: noColorOptions,
			result: FAILING_RESULT,
		});

		expect(output).toContain("▶ auth");
		expect(output).toContain("player.spec.ts");
	});

	it("should include exec error details", () => {
		expect.assertions(2);

		const ctx = { currentIndex: 1, totalFailures: 1 };
		const output = formatProjectSection({
			displayName: "broken",
			failureCtx: ctx,
			options: noColorOptions,
			result: EXEC_ERROR_RESULT,
		});

		expect(output).toContain("▶ broken");
		expect(output).toContain("unit-menu-app");
	});
});

describe(formatMultiProjectResult, () => {
	const noColorOptions: FormatOptions = { ...defaultOptions, color: false };

	it("should group files under project headers with combined summary", () => {
		expect.assertions(5);

		const output = formatMultiProjectResult(
			[
				{ displayName: "core", result: PASSING_RESULT },
				{ displayName: "integration", result: PASSING_RESULT },
			],
			TIMING,
			noColorOptions,
		);

		expect(output).toContain("▶ core");
		expect(output).toContain("▶ integration");
		expect(output).toContain("Test Files");
		expect(output).toContain("6 passed");
		expect(output).toContain("RUN");
	});

	it("should show failure details within project sections", () => {
		expect.assertions(4);

		const output = formatMultiProjectResult(
			[
				{ displayName: "core", result: PASSING_RESULT },
				{ displayName: "auth", result: FAILING_RESULT },
			],
			TIMING,
			noColorOptions,
		);

		expect(output).toContain("▶ core");
		expect(output).toContain("▶ auth");
		expect(output).toContain("should have health");
		expect(output).toContain("Test Files");
	});

	it("should show failures from multiple projects", () => {
		expect.assertions(3);

		const output = formatMultiProjectResult(
			[
				{ displayName: "a", result: FAILING_RESULT },
				{ displayName: "b", result: MIXED_RESULT },
			],
			TIMING,
			noColorOptions,
		);

		expect(output).toContain("▶ a");
		expect(output).toContain("▶ b");
		expect(output).toContain("Tests");
	});
});

describe("multi-project output snapshots", () => {
	const baseOptions: FormatOptions = {
		color: false,
		rootDir: "/project",
		verbose: false,
		version: "1.0.0",
	};

	it("should format project header for passing result", () => {
		expect.assertions(1);

		const output = formatProjectHeader({ displayName: "core", result: PASSING_RESULT });
		const plain = stripVTControlCharacters(output);

		expect(plain).toMatchInlineSnapshot('"▶  core   1 passed (3 tests - 30ms)"');
	});

	it("should format project header for failing result", () => {
		expect.assertions(1);

		const output = formatProjectHeader({ displayName: "auth", result: FAILING_RESULT });
		const plain = stripVTControlCharacters(output);

		expect(plain).toMatchInlineSnapshot('"▶  auth   1 failed (3 tests - 18ms)"');
	});

	it("should format project header for skipped result", () => {
		expect.assertions(1);

		const output = formatProjectHeader({ displayName: "utils", result: SKIPPED_RESULT });
		const plain = stripVTControlCharacters(output);

		expect(plain).toMatchInlineSnapshot('"▶  utils   1 passed | 2 skipped (12 tests - 50ms)"');
	});

	it("should format project section for passing result", () => {
		expect.assertions(1);

		const failureCtx = { currentIndex: 1, totalFailures: 0 };
		const output = formatProjectSection({
			displayName: "core",
			failureCtx,
			options: baseOptions,
			result: PASSING_RESULT,
		});

		expect(output).toMatchInlineSnapshot(`
			"▶ core  1 passed (3 tests - 30ms)
			 ✓ src/utils.spec.ts (3 tests - 30ms)"
		`);
	});

	it("should format project section for failing result", () => {
		expect.assertions(1);

		const failureCtx = { currentIndex: 1, totalFailures: 2 };
		const output = formatProjectSection({
			displayName: "auth",
			failureCtx,
			options: baseOptions,
			result: FAILING_RESULT,
		});

		expect(output).toMatchInlineSnapshot(`
			"▶ auth  1 failed (3 tests - 18ms)
			 ❯ src/player.spec.ts (3 tests | 2 failed)
			   ❯ Player (3 tests | 2 failed) 18ms
			     ✓ should spawn 10ms
			     × should have health 5ms
			     × should be alive 3ms
			  
			   FAIL  src/player.spec.ts > Player > should have health
			  expect(received).toBe(expected)
			  
			  - Expected
			  + Received
			  
			  - 100
			  + 0
			  
			  ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯
			  
			   FAIL  src/player.spec.ts > Player > should be alive
			  expect(received).toBe(expected)
			  
			  - Expected
			  + Received
			  
			  - true
			  + false
			  
			  ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯"
		`);
	});

	it("should format multi-project result with two passing projects", () => {
		expect.assertions(1);

		const output = formatMultiProjectResult(
			[
				{ displayName: "core", result: PASSING_RESULT },
				{ displayName: "integration", result: PASSING_RESULT },
			],
			TIMING,
			baseOptions,
		);

		expect(output).toMatchInlineSnapshot(`
			"
			 RUN  v1.0.0 /project

			▶ core  1 passed (3 tests - 30ms)
			 ✓ src/utils.spec.ts (3 tests - 30ms)

			▶ integration  1 passed (3 tests - 30ms)
			 ✓ src/utils.spec.ts (3 tests - 30ms)

			 Test Files  2 passed (2)
			      Tests  6 passed (6)
			   Start at  22:13:20
			   Duration  250ms (upload 50ms, environment 50ms, tests 100ms, cli 50ms)"
		`);
	});

	it("should format multi-project result with passing and failing projects", () => {
		expect.assertions(1);

		const output = formatMultiProjectResult(
			[
				{ displayName: "core", result: PASSING_RESULT },
				{ displayName: "auth", result: FAILING_RESULT },
			],
			TIMING,
			baseOptions,
		);

		expect(output).toMatchInlineSnapshot(`
			"
			 RUN  v1.0.0 /project

			▶ core  1 passed (3 tests - 30ms)
			 ✓ src/utils.spec.ts (3 tests - 30ms)

			▶ auth  1 failed (3 tests - 18ms)
			 ❯ src/player.spec.ts (3 tests | 2 failed)
			   ❯ Player (3 tests | 2 failed) 18ms
			     ✓ should spawn 10ms
			     × should have health 5ms
			     × should be alive 3ms
			  
			   FAIL  src/player.spec.ts > Player > should have health
			  expect(received).toBe(expected)
			  
			  - Expected
			  + Received
			  
			  - 100
			  + 0
			  
			  ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯
			  
			   FAIL  src/player.spec.ts > Player > should be alive
			  expect(received).toBe(expected)
			  
			  - Expected
			  + Received
			  
			  - true
			  + false
			  
			  ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯

			 Test Files  1 passed | 1 failed (2)
			      Tests  4 passed | 2 failed (6)
			   Start at  22:13:20
			   Duration  250ms (upload 50ms, environment 50ms, tests 100ms, cli 50ms)"
		`);
	});

	it("should format multi-project result with skipped files in summary", () => {
		expect.assertions(3);

		const output = formatMultiProjectResult(
			[
				{ displayName: "core", result: PASSING_RESULT },
				{ displayName: "utils", result: SKIPPED_RESULT },
			],
			TIMING,
			baseOptions,
		);

		expect(output).toContain("2 skipped");
		expect(output).toContain("7 skipped");
		expect(output).toContain("Test Files");
	});

	it("should aggregate results when projects have todo tests", () => {
		expect.assertions(2);

		const withTodo: JestResult = {
			...PASSING_RESULT,
			numTodoTests: 2,
		};

		const output = formatMultiProjectResult(
			[
				{ displayName: "core", result: withTodo },
				{ displayName: "utils", result: PASSING_RESULT },
			],
			TIMING,
			baseOptions,
		);

		expect(output).toContain("6 passed");
		expect(output).not.toContain("todo");
	});

	it("should aggregate snapshots across multi-project results", () => {
		expect.assertions(2);

		const withSnapshot: JestResult = {
			...PASSING_RESULT,
			snapshot: { added: 0, matched: 3, total: 5, unmatched: 2, updated: 0 },
		};

		const output = formatMultiProjectResult(
			[
				{ displayName: "core", result: withSnapshot },
				{ displayName: "utils", result: PASSING_RESULT },
			],
			TIMING,
			baseOptions,
		);

		expect(output).toContain("Snapshots");
		expect(output).toContain("2 failed");
	});
});

describe(formatProjectBadge, () => {
	it("should return plain text when color is disabled", () => {
		expect.assertions(1);

		const output = formatProjectBadge("core", false);

		expect(output).toBe("▶ core");
	});

	it("should apply named displayColor when provided", () => {
		expect.assertions(2);

		const output = formatProjectBadge("core", true, "red");

		expect(output).toContain("core");
		expect(output).not.toBe("▶ core");
	});

	it("should fall back to hash-based color for unknown displayColor", () => {
		expect.assertions(2);

		const output = formatProjectBadge("core", true, "nonexistent");

		expect(output).toContain("core");
		expect(output).not.toBe("▶ core");
	});

	it("should apply all named displayColors", () => {
		expect.assertions(7);

		const colors = ["blue", "cyan", "green", "magenta", "red", "white", "yellow"];

		for (const colorName of colors) {
			const output = formatProjectBadge("x", true, colorName);

			expect(output).not.toBe("▶ x");
		}
	});

	it("should use all hash-based badge colors", () => {
		expect.assertions(4);

		// d→0 (bgYellow), a→1 (bgCyan), b→2 (bgGreen), c→3 (bgMagenta)
		for (const name of ["d", "a", "b", "c"]) {
			const output = formatProjectBadge(name, true);

			expect(output).not.toBe(`▶ ${name}`);
		}
	});
});

describe("formatProjectSection failuresOnly", () => {
	it("should skip passing files when failuresOnly is true", () => {
		expect.assertions(2);

		const failureCtx = { currentIndex: 1, totalFailures: 2 };
		const options: FormatOptions = {
			color: false,
			failuresOnly: true,
			rootDir: "/project",
			verbose: false,
			version: "1.0.0",
		};

		const output = formatProjectSection({
			displayName: "auth",
			failureCtx,
			options,
			result: MIXED_RESULT,
		});

		expect(output).not.toContain("src/utils.spec.ts");
		expect(output).toContain("src/game.spec.ts");
	});
});

describe("multi-project log hints", () => {
	it("should show log hints when multi-project result has failures", () => {
		expect.assertions(2);

		const options: FormatOptions = {
			color: false,
			gameOutput: "game.log",
			outputFile: "results.json",
			rootDir: "/project",
			verbose: false,
			version: "1.0.0",
		};

		const output = formatMultiProjectResult(
			[
				{ displayName: "core", result: PASSING_RESULT },
				{ displayName: "auth", result: FAILING_RESULT },
			],
			TIMING,
			options,
		);

		expect(output).toContain("View results.json");
		expect(output).toContain("View game.log");
	});
});
