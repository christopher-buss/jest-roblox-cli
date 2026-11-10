import { fromPartial } from "@total-typescript/shoehorn";

import { stripVTControlCharacters } from "node:util";
import color from "tinyrainbow";
import type { Except } from "type-fest";
import { describe, expect, it } from "vitest";

import {
	EXEC_ERROR_RESULT,
	LOADSTRING_ERROR_RESULT,
	MIXED_WITH_EXEC_ERROR_RESULT,
	TIMED_OUT_RESULT,
} from "#test/mocks/format-error-results.ts";
import { createPlainStyles } from "#test/mocks/format-plain-styles.ts";
import {
	EMPTY_FILE_RESULT,
	FAILING_RESULT,
	MIXED_RESULT,
	PASSING_RESULT,
	SKIPPED_RESULT,
	SNAPSHOT_FAILING_RESULT,
} from "#test/mocks/format-results.ts";
import { createTaggedStyles } from "#test/mocks/format-tagged-styles.ts";
import { TIMING, TIMING_NO_UPLOAD } from "#test/mocks/format-timing.ts";
import {
	TYPECHECK_FAILING_RESULT,
	TYPECHECK_MIXED_RESULT,
	TYPECHECK_PASSING_RESULT,
} from "#test/mocks/format-typecheck-results.ts";
import type { JestResult, TestCaseResult, TestFileResult } from "../types/jest-result-types.ts";
import type { TimingResult } from "../types/timing-types.ts";
import { formatMultiProjectResult, formatResult, formatTypecheckReport } from "./formatter.ts";
import type { FormatOptions, FormatterProjectEntry } from "./shared.ts";

function createTiming(totalMs: number): TimingResult {
	return {
		executionMs: 100,
		startTime: Date.now(),
		testsMs: 50,
		totalMs,
		uploadMs: 50,
	};
}

const defaultOptions: FormatOptions = {
	color: true,
	rootDir: "/project",
	verbose: false,
	version: "1.0.0",
};

function passingFileResult({
	testFilePath,
	testResults = [],
	...overrides
}: Except<Partial<JestResult>, "testResults"> & {
	testFilePath: string;
	testResults?: Array<TestCaseResult>;
}): JestResult {
	return {
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
				testFilePath,
				testResults,
			},
		],
		...overrides,
	};
}

function renderSnapshotLine(projectA: JestResult, projectB: JestResult): string | undefined {
	const output = formatMultiProjectResult({
		options: { ...defaultOptions, color: false },
		projects: [
			{ displayName: "a", result: projectA },
			{ displayName: "b", result: projectB },
		],
		timing: TIMING,
	});
	return output.split("\n").find((line) => line.includes("Snapshots"));
}

const SLOW_TEST_RESULT = passingFileResult({
	testFilePath: "src/d.spec.ts",
	testResults: [
		{
			ancestorTitles: ["S"],
			duration: 100,
			failureMessages: [],
			fullName: "S t",
			status: "passed",
			title: "t",
		},
	],
});

function formatEmptyPassingFile(testFilePath: string, totalMs: number): string {
	return formatResult({
		options: { ...defaultOptions, color: false },
		result: passingFileResult({ testFilePath }),
		timing: createTiming(totalMs),
	});
}

function renderProject(entry: FormatterProjectEntry, options: FormatOptions): string {
	const output = formatMultiProjectResult({
		options,
		projects: [entry],
		timing: createTiming(100),
	});
	return output.slice(1, output.lastIndexOf("\n\n", output.indexOf("Test Files")));
}

function renderProjectHeader(entry: FormatterProjectEntry, useColor = true): string {
	return renderProject(entry, { ...defaultOptions, color: useColor }).split("\n", 1)[0]!;
}

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

		const formatted = formatResult({
			options: defaultOptions,
			result,
			timing: createTiming(1000),
		});

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

		const formatted = formatResult({
			options: defaultOptions,
			result,
			timing: createTiming(1000),
		});

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

		const formatted = formatResult({
			options: {
				...defaultOptions,
				verbose: true,
			},
			result,
			timing: createTiming(1000),
		});

		expect(formatted).toContain("✓ Utils add works");
		expect(formatted).toContain("✓ Utils sub works");
	});

	it("should strip ANSI codes when color is false", () => {
		expect.assertions(2);

		const formatted = formatEmptyPassingFile("test.spec.ts", 1000);

		expect(stripVTControlCharacters(formatted)).toBe(formatted);
		expect(formatted).toContain("✓");
	});

	it("should format directory path with dim style", () => {
		expect.assertions(2);

		const formatted = formatEmptyPassingFile("src/components/Button.spec.ts", 1000);

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

		const output = formatResult({ options: baseOptions, result: MIXED_RESULT, timing: TIMING });

		expect(output).not.toContain("utils.spec.ts");
		expect(output).toContain("game.spec.ts");
	});

	it("should still show failing file with describe groups", () => {
		expect.assertions(3);

		const output = formatResult({ options: baseOptions, result: MIXED_RESULT, timing: TIMING });

		expect(output).toContain("❯ src/game.spec.ts");
		expect(output).toContain("should end");
		expect(output).toContain("Failed Tests");
	});

	it("should still show summary footer", () => {
		expect.assertions(2);

		const output = formatResult({ options: baseOptions, result: MIXED_RESULT, timing: TIMING });

		expect(output).toContain("Test Files");
		expect(output).toContain("Tests");
	});

	it("should show no file summaries when all tests pass", () => {
		expect.assertions(2);

		const output = formatResult({
			options: baseOptions,
			result: PASSING_RESULT,
			timing: TIMING,
		});

		expect(output).not.toContain("utils.spec.ts");
		expect(output).toContain("Test Files");
	});
});

describe("formatResult log hints", () => {
	it("should show output file hint on failure", () => {
		expect.assertions(2);

		const output = formatResult({
			options: {
				...defaultOptions,
				color: false,
				outputFile: "/tmp/results.json",
			},
			result: FAILING_RESULT,
			timing: TIMING,
		});

		expect(output).toContain("View /tmp/results.json for full Jest output");
		expect(output).toContain("\n\n  View /tmp/results.json for full Jest output");
	});

	it("should show game output hint on failure", () => {
		expect.assertions(1);

		const output = formatResult({
			options: {
				...defaultOptions,
				color: false,
				gameOutput: "/tmp/game.json",
			},
			result: FAILING_RESULT,
			timing: TIMING,
		});

		expect(output).toContain("View /tmp/game.json for Roblox game logs");
	});

	it("should show both hints when both paths configured", () => {
		expect.assertions(2);

		const output = formatResult({
			options: {
				...defaultOptions,
				color: false,
				gameOutput: "/tmp/game.json",
				outputFile: "/tmp/results.json",
			},
			result: FAILING_RESULT,
			timing: TIMING,
		});

		expect(output).toContain("View /tmp/results.json for full Jest output");
		expect(output).toContain("View /tmp/game.json for Roblox game logs");
	});

	it("should not show hints on passing results", () => {
		expect.assertions(2);

		const output = formatResult({
			options: {
				...defaultOptions,
				color: false,
				gameOutput: "/tmp/game.json",
				outputFile: "/tmp/results.json",
			},
			result: PASSING_RESULT,
			timing: TIMING,
		});

		expect(output).not.toContain("View /tmp/results.json");
		expect(output).not.toContain("View /tmp/game.json");
	});

	it("should not show hints when no paths configured", () => {
		expect.assertions(2);

		const output = formatResult({
			options: {
				...defaultOptions,
				color: false,
			},
			result: FAILING_RESULT,
			timing: TIMING,
		});

		expect(output).not.toContain("View");
		expect(output).not.toContain("for full Jest output");
	});

	it("should suggest -u when snapshot assertions failed", () => {
		expect.assertions(1);

		const result: JestResult = {
			numFailedTests: 1,
			numPassedTests: 0,
			numPendingTests: 0,
			numTotalTests: 1,
			snapshot: { added: 0, matched: 0, total: 1, unmatched: 1, updated: 0 },
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

		const output = formatResult({
			options: { ...defaultOptions, color: false },
			result,
			timing: TIMING,
		});

		expect(output).toMatch(/Inspect your code changes or rerun with `-u` to update snapshots/);
	});

	it("should not suggest -u when no snapshot mismatches", () => {
		expect.assertions(1);

		const output = formatResult({
			options: {
				...defaultOptions,
				color: false,
			},
			result: FAILING_RESULT,
			timing: TIMING,
		});

		expect(output).not.toContain("rerun with `-u`");
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

		const output = formatResult({
			options: baseOptions,
			result: PASSING_RESULT,
			timing: TIMING,
		});

		expect(output).toMatchInlineSnapshot(`
			"
			 ✓ src/utils.spec.ts (3 tests - 30ms)

			 Test Files  1 passed (1)
			      Tests  3 passed (3)
			   Start at  22:13:20
			   Duration  250ms (upload 50ms, environment 50ms, tests 100ms, cli 50ms)"
		`);
	});

	it("should format failing results", () => {
		expect.assertions(1);

		const output = formatResult({
			options: baseOptions,
			result: FAILING_RESULT,
			timing: TIMING,
		});

		expect(output).toMatchInlineSnapshot(`
			"
			 ❯ src/player.spec.ts (3 tests | 2 failed)
			   ❯ Player (3 tests | 2 failed) 18ms
			     ✓ should spawn 10ms
			     × should have health 5ms
			     × should be alive 3ms

			⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯
			  
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
			      Tests  2 failed | 1 passed (3)
			   Start at  22:13:20
			   Duration  250ms (upload 50ms, environment 50ms, tests 100ms, cli 50ms)"
		`);
	});

	it("should format mixed results", () => {
		expect.assertions(1);

		const output = formatResult({ options: baseOptions, result: MIXED_RESULT, timing: TIMING });

		expect(output).toMatchInlineSnapshot(`
			"
			 ✓ src/utils.spec.ts (2 tests - 20ms)
			 ❯ src/game.spec.ts (4 tests | 1 failed)
			   ❯ Game (4 tests | 1 failed) 28ms
			     ✓ should start 10ms
			     ✓ should pause 10ms
			     × should end 8ms
			     ↓ should restart

			⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯
			  
			   FAIL  src/game.spec.ts > Game > should end
			  expect(received).toBe(expected)
			  
			  - Expected
			  + Received
			  
			  - "ended"
			  + "running"
			  
			  ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

			 Test Files  1 failed | 1 passed (2)
			      Tests  1 failed | 4 passed | 1 skipped (6)
			   Start at  22:13:20
			   Duration  250ms (upload 50ms, environment 50ms, tests 100ms, cli 50ms)"
		`);
	});

	it("should format skipped file results", () => {
		expect.assertions(1);

		const output = formatResult({
			options: baseOptions,
			result: SKIPPED_RESULT,
			timing: TIMING,
		});

		expect(output).toMatchInlineSnapshot(`
			"
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

		const output = formatResult({
			options: baseOptions,
			result: SNAPSHOT_FAILING_RESULT,
			timing: TIMING,
		});

		expect(output).toContain("- Snapshot  - 2");
		expect(output).toContain("+ Received  + 2");
		expect(output).toContain('-   "health": 100,');
		expect(output).toContain('+   "health": 150,');
	});

	it("should format without upload when timing has no upload", () => {
		expect.assertions(1);

		const output = formatResult({
			options: baseOptions,
			result: PASSING_RESULT,
			timing: TIMING_NO_UPLOAD,
		});

		expect(output).toMatchInlineSnapshot(`
			"
			 ✓ src/utils.spec.ts (3 tests - 30ms)

			 Test Files  1 passed (1)
			      Tests  3 passed (3)
			   Start at  22:13:20
			   Duration  200ms (environment 50ms, tests 100ms, cli 50ms)"
		`);
	});

	it("should format with verbose mode", () => {
		expect.assertions(1);

		const output = formatResult({
			options: { ...baseOptions, verbose: true },
			result: PASSING_RESULT,
			timing: TIMING,
		});

		expect(output).toMatchInlineSnapshot(`
			"
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

		const output = formatResult({
			options: {
				...baseOptions,
				collectCoverage: true,
			},
			result: PASSING_RESULT,
			timing: TIMING,
		});

		expect(output).toMatchInlineSnapshot(`
			"
			 ✓ src/utils.spec.ts (3 tests - 30ms)

			 Test Files  1 passed (1)
			      Tests  3 passed (3)
			   Start at  22:13:20
			   Duration  250ms (upload 50ms, environment 50ms, tests 100ms, cli 50ms)"
		`);
	});

	it("should format with coverage enabled and verbose mode", () => {
		expect.assertions(1);

		const output = formatResult({
			options: {
				...baseOptions,
				collectCoverage: true,
				verbose: true,
			},
			result: PASSING_RESULT,
			timing: TIMING,
		});

		expect(output).toMatchInlineSnapshot(`
			"
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

describe("formatResult exec errors", () => {
	it("should show exec-error file with fail symbol and error message", () => {
		expect.assertions(3);

		const output = formatResult({
			options: {
				...defaultOptions,
				color: false,
			},
			result: EXEC_ERROR_RESULT,
			timing: TIMING,
		});

		expect(output).toContain("unit-menu-app.test");
		expect(output).toContain("Require-by-string is not enabled");
		// Must not show "↓" (skipped symbol)
		expect(output).not.toContain("\u2193");
	});

	it("should show exec-error in detailed failures section", () => {
		expect.assertions(2);

		const output = formatResult({
			options: {
				...defaultOptions,
				color: false,
			},
			result: EXEC_ERROR_RESULT,
			timing: TIMING,
		});

		expect(output).toContain("Failed Tests");
		expect(output).toContain("Require-by-string is not enabled");
	});

	it("should show log hints for exec-error results", () => {
		expect.assertions(1);

		const output = formatResult({
			options: {
				...defaultOptions,
				color: false,
				outputFile: "/tmp/results.json",
			},
			result: EXEC_ERROR_RESULT,
			timing: TIMING,
		});

		expect(output).toContain("View /tmp/results.json for full Jest output");
	});

	it("should render the exec-error message exactly once", () => {
		expect.assertions(1);

		const output = formatResult({
			options: {
				...defaultOptions,
				color: false,
			},
			result: EXEC_ERROR_RESULT,
			timing: TIMING,
		});

		const occurrences =
			output.split("Require-by-string is not enabled for use inside Jest at this time.")
				.length - 1;

		expect(occurrences).toBe(1);
	});
});

describe("formatResult timeouts", () => {
	it("should name the budget rather than a suite that threw", () => {
		expect.assertions(5);

		const output = formatResult({
			options: {
				...defaultOptions,
				color: false,
			},
			result: TIMED_OUT_RESULT,
			timing: TIMING,
		});

		expect(output).toContain("Test suite timed out");
		expect(output).not.toContain("Test suite failed to run");
		expect(output).toContain("Timed out after 60s, aborting tests. Raise test.projectTimeout");
		expect(output).toContain(" TIMEOUT ");
		expect(output).not.toContain(" FAIL ");
	});

	it("should keep the test the run was abandoned in", () => {
		expect.assertions(1);

		const output = formatResult({
			options: {
				...defaultOptions,
				color: false,
			},
			result: TIMED_OUT_RESULT,
			timing: TIMING,
		});

		expect(output).toContain(
			'Last test seen: "wedge wedges without yielding" in ReplicatedStorage/PkgShared/wedge.spec (running for 52.3s)',
		);
	});

	it("should paint the timeout badge apart from the fail badge", () => {
		expect.assertions(2);

		const output = formatResult({
			options: {
				...defaultOptions,
				color: true,
			},
			result: TIMED_OUT_RESULT,
			timing: TIMING,
		});
		const plainFailure = formatResult({
			options: {
				...defaultOptions,
				color: true,
			},
			result: EXEC_ERROR_RESULT,
			timing: TIMING,
		});

		expect(output).toContain(color.bgYellow(color.black(color.bold(" TIMEOUT "))));
		expect(plainFailure).toContain(color.bgRed(color.white(color.bold(" FAIL "))));
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

		const output = formatResult({
			options: baseOptions,
			result: EXEC_ERROR_RESULT,
			timing: TIMING,
		});

		expect(output).toMatchInlineSnapshot(`
			"
			 ✗ shared/react/features/windows/__tests__/unit-menu-app.test

			⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯
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

		const output = formatResult({
			options: baseOptions,
			result: MIXED_WITH_EXEC_ERROR_RESULT,
			timing: TIMING,
		});

		expect(output).toMatchInlineSnapshot(`
			"
			 ✓ src/utils.spec.ts (3 tests - 30ms)
			 ✗ src/broken.spec.ts

			⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯
			   FAIL  src/broken.spec.ts
			  Test suite failed to run

			  Require-by-string is not enabled for use inside Jest at this time.

			  ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

			 Test Files  1 failed | 1 passed (2)
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

		const output = formatResult({
			options: baseOptions,
			result: TYPECHECK_PASSING_RESULT,
			timing: TIMING_NO_UPLOAD,
		});

		expect(output).toMatchInlineSnapshot(`
			"
			 ✓ src/types.test-d.ts (2 tests)

			 Test Files  1 passed (1)
			      Tests  2 passed (2)
			   Start at  22:13:20
			   Duration  200ms (environment 50ms, tests 100ms, cli 50ms)"
		`);
	});

	it("should format failing typecheck result", () => {
		expect.assertions(1);

		const output = formatResult({
			options: baseOptions,
			result: TYPECHECK_FAILING_RESULT,
			timing: TIMING_NO_UPLOAD,
		});

		expect(output).toMatchInlineSnapshot(`
			"
			 ❯ src/types.test-d.ts (2 tests | 1 failed)
			   ❯ type checks (2 tests | 1 failed)
			     × should reject string as number
			     ✓ should accept number

			⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯
			  
			   FAIL  src/types.test-d.ts > type checks > should reject string as number
			  TS2322: Type 'string' is not assignable to type 'number'.
			  
			  ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

			 Test Files  1 failed (1)
			      Tests  1 failed | 1 passed (2)
			   Start at  22:13:20
			   Duration  200ms (environment 50ms, tests 100ms, cli 50ms)"
		`);
	});

	it("should format mixed typecheck result", () => {
		expect.assertions(1);

		const output = formatResult({
			options: baseOptions,
			result: TYPECHECK_MIXED_RESULT,
			timing: TIMING_NO_UPLOAD,
		});

		expect(output).toMatchInlineSnapshot(`
			"
			 ✓ src/passing.test-d.ts (2 tests)
			 ❯ src/failing.test-d.ts (2 tests | 1 failed)
			   ❯ failing types (2 tests | 1 failed)
			     × should reject string as number
			     ✓ should pass this one

			⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯
			  
			   FAIL  src/failing.test-d.ts > failing types > should reject string as number
			  TS2322: Type 'string' is not assignable to type 'number'.
			  
			  ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

			 Test Files  1 failed | 1 passed (2)
			      Tests  1 failed | 3 passed (4)
			   Start at  22:13:20
			   Duration  200ms (environment 50ms, tests 100ms, cli 50ms)"
		`);
	});
});

describe("formatTypecheckReport snapshots", () => {
	it("should render with the palette it is given", () => {
		expect.assertions(1);

		const output = formatTypecheckReport(TYPECHECK_PASSING_RESULT, {
			styles: createTaggedStyles(),
		});

		expect(output).toContain("<summaryPassed>2 passed</summaryPassed>");
	});

	it("should format passing typecheck summary", () => {
		expect.assertions(1);

		const output = formatTypecheckReport(TYPECHECK_PASSING_RESULT, {
			styles: createPlainStyles(),
		});

		expect(output).toMatchInlineSnapshot(`
			"
			      Tests  2 passed (2)
			Type Errors  no errors
			"
		`);
	});

	it("should format failing typecheck summary with failures", () => {
		expect.assertions(1);

		const output = formatTypecheckReport(TYPECHECK_FAILING_RESULT, {
			styles: createPlainStyles(),
		});

		expect(output).toMatchInlineSnapshot(`
			"   FAIL  type checks > should reject string as number
			    TS2322: Type 'string' is not assignable to type 'number'.

			      Tests  1 failed | 1 passed (2)
			Type Errors  1 failed
			"
		`);
	});

	it("should format mixed typecheck summary with failure from one file", () => {
		expect.assertions(1);

		const output = formatTypecheckReport(TYPECHECK_MIXED_RESULT, {
			styles: createPlainStyles(),
		});

		expect(output).toMatchInlineSnapshot(`
			"   FAIL  failing types > should reject string as number
			    TS2322: Type 'string' is not assignable to type 'number'.

			      Tests  1 failed | 3 passed (4)
			Type Errors  1 failed
			"
		`);
	});
});

describe("formatTypecheckReport without summary rows", () => {
	it("should return the failure detail alone, newline-terminated", () => {
		expect.assertions(1);

		const output = formatTypecheckReport(TYPECHECK_FAILING_RESULT, {
			includeSummaryRows: false,
			styles: createPlainStyles(),
		});

		expect(output).toMatchInlineSnapshot(`
			"   FAIL  type checks > should reject string as number
			    TS2322: Type 'string' is not assignable to type 'number'.
			"
		`);
	});

	it("should return nothing when a clean pass leaves no detail", () => {
		expect.assertions(1);

		const output = formatTypecheckReport(TYPECHECK_PASSING_RESULT, {
			includeSummaryRows: false,
			styles: createPlainStyles(),
		});

		expect(output).toBe("");
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
		const formatted = formatResult({
			options: {
				...defaultOptions,
				color: true,
			},
			result,
			timing: createTiming(1000),
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

		const formatted = formatEmptyPassingFile("test.spec.ts", 500);

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

		const formatted = formatResult({
			options: {
				...defaultOptions,
				color: false,
			},
			result,
			timing: createTiming(500),
		});
		const plain = stripVTControlCharacters(formatted);

		// The passed test line should end with the title, no "ms" suffix
		expect(plain).toContain("✓ no-dur passes");
		expect(plain).toContain("× no-dur fails");
	});
});

describe("formatTestInGroup skipped statuses", () => {
	function buildResult(skippedStatus: TestCaseResult["status"]): JestResult {
		const fileResult: TestFileResult = {
			numFailingTests: 1,
			numPassingTests: 0,
			numPendingTests: 1,
			testFilePath: "src/skipped.spec.ts",
			testResults: [
				{
					ancestorTitles: ["Suite"],
					duration: 5,
					failureMessages: ["Expected: 1\nReceived: 2"],
					fullName: "Suite real failure",
					status: "failed",
					title: "real failure",
				},
				{
					ancestorTitles: ["Suite"],
					duration: 99,
					failureMessages: [],
					fullName: "Suite skipped-case",
					status: skippedStatus,
					title: "skipped-case",
				},
			],
		};

		return {
			numFailedTests: 1,
			numPassedTests: 0,
			numPendingTests: 1,
			numTotalTests: 2,
			startTime: 0,
			success: false,
			testResults: [fileResult],
		};
	}

	it("should render pending test with yellow ↓ and no ms suffix", () => {
		expect.assertions(4);

		const formatted = formatResult({
			options: {
				...defaultOptions,
				color: true,
			},
			result: buildResult("pending"),
			timing: createTiming(500),
		});
		const plain = stripVTControlCharacters(formatted);

		expect(plain).toContain("↓ skipped-case");
		expect(plain).not.toContain("× skipped-case");
		expect(plain).not.toMatch(/skipped-case\s+\d+ms/);
		expect(formatted).toContain("[33m     ↓ skipped-case[39m");
	});

	it("should render skipped status with yellow ↓ and no ms suffix", () => {
		expect.assertions(4);

		const formatted = formatResult({
			options: {
				...defaultOptions,
				color: true,
			},
			result: buildResult("skipped"),
			timing: createTiming(500),
		});
		const plain = stripVTControlCharacters(formatted);

		expect(plain).toContain("↓ skipped-case");
		expect(plain).not.toContain("× skipped-case");
		expect(plain).not.toMatch(/skipped-case\s+\d+ms/);
		expect(formatted).toContain("[33m     ↓ skipped-case[39m");
	});

	it("should render todo status with yellow □ and no ms suffix", () => {
		expect.assertions(4);

		const formatted = formatResult({
			options: {
				...defaultOptions,
				color: true,
			},
			result: buildResult("todo"),
			timing: createTiming(500),
		});
		const plain = stripVTControlCharacters(formatted);

		expect(plain).toContain("□ skipped-case");
		expect(plain).not.toContain("× skipped-case");
		expect(plain).not.toMatch(/skipped-case\s+\d+ms/);
		expect(formatted).toContain("[33m     □ skipped-case[39m");
	});

	it("should render disabled status with yellow ↓ and no ms suffix", () => {
		expect.assertions(4);

		const formatted = formatResult({
			options: {
				...defaultOptions,
				color: true,
			},
			result: buildResult("disabled"),
			timing: createTiming(500),
		});
		const plain = stripVTControlCharacters(formatted);

		expect(plain).toContain("↓ skipped-case");
		expect(plain).not.toContain("× skipped-case");
		expect(plain).not.toMatch(/skipped-case\s+\d+ms/);
		expect(formatted).toContain("[33m     ↓ skipped-case[39m");
	});

	it("should exclude skipped test duration from group aggregate", () => {
		expect.assertions(3);

		// buildResult has failed.duration=5 and skipped.duration=99. The group
		// header total must reflect only counted (passed/failed) durations.
		const formatted = formatResult({
			options: {
				...defaultOptions,
				color: false,
			},
			result: buildResult("pending"),
			timing: createTiming(500),
		});
		const plain = stripVTControlCharacters(formatted);

		expect(plain).toContain("Suite (2 tests | 1 failed) 5ms");
		expect(plain).not.toContain("104ms");
		expect(plain).not.toContain("99ms");
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

		const formatted = formatResult({
			options: {
				...defaultOptions,
				color: false,
				verbose: true,
			},
			result,
			timing: createTiming(500),
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

		const formatted = formatResult({
			options: {
				...defaultOptions,
				color: false,
				verbose: true,
			},
			result,
			timing: createTiming(500),
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

		const formatted = formatResult({
			options: {
				...defaultOptions,
				color: false,
			},
			result,
			timing: createTiming(500),
		});

		expect(formatted).toContain("(root)");
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
			formatResult({
				options: {
					...defaultOptions,
					color: true,
					sourceMapper: fromPartial({
						mapFailureWithLocations: (message: string) => {
							return {
								locations: [],
								message,
							};
						},
						resolveDisplayPath: () => "src/client/example/test.spec.ts",
						resolveTestFilePath: () => "src/client/example/test.spec.ts",
					}),
				},
				result,
				timing: TIMING,
			}),
		);

		expect(output).toContain("src/client/example/test.spec.ts");
		expect(output).not.toContain("ReplicatedStorage");
	});

	it("should display init.spec as index.spec when sourceMapper rewrites it", () => {
		expect.assertions(2);

		const result: JestResult = {
			numFailedTests: 0,
			numPassedTests: 1,
			numPendingTests: 0,
			numTotalTests: 1,
			startTime: 1700000000000,
			success: true,
			testResults: [
				{
					numFailingTests: 0,
					numPassingTests: 1,
					numPendingTests: 0,
					testFilePath: "src/init.spec",
					testResults: [
						{
							ancestorTitles: ["root"],
							duration: 1,
							failureMessages: [],
							fullName: "root passes",
							status: "passed" as const,
							title: "passes",
						},
					],
				},
			],
		};

		const output = stripVTControlCharacters(
			formatResult({
				options: {
					...defaultOptions,
					color: false,
					sourceMapper: fromPartial({
						mapFailureWithLocations: (message: string) => ({ locations: [], message }),
						resolveDisplayPath: (testFilePath: string) => {
							return testFilePath.replace("init.spec", "index.spec");
						},
						resolveTestFilePath: () => {},
					}),
				},
				result,
				timing: TIMING,
			}),
		);

		expect(output).toContain("src/index.spec");
		expect(output).not.toContain("src/init.spec");
	});
});

describe("formatResult loadstring hint", () => {
	it("should show hint when loadstring is not available", () => {
		expect.assertions(2);

		const output = formatResult({
			options: {
				...defaultOptions,
				color: false,
			},
			result: LOADSTRING_ERROR_RESULT,
			timing: TIMING,
		});

		expect(output).toContain("loadstring() is not available");
		expect(output).toContain("LoadStringEnabled");
	});
});

// --- Multi-project output ---

describe("multi-project header", () => {
	it("should show project name with pass count and test total", () => {
		expect.assertions(4);

		const output = renderProjectHeader({ displayName: "core", result: PASSING_RESULT });
		const plain = stripVTControlCharacters(output);

		expect(plain).toContain("▶  core ");
		expect(plain).toContain("1 passed");
		expect(plain).toContain("3 tests");
		expect(plain).not.toContain("failed");
	});

	it("should show failed file count when tests fail", () => {
		expect.assertions(2);

		const output = renderProjectHeader({ displayName: "auth", result: FAILING_RESULT });
		const plain = stripVTControlCharacters(output);

		expect(plain).toContain("1 failed");
		expect(plain).toContain("3 tests");
	});

	it("should show skipped count for skip-only files", () => {
		expect.assertions(3);

		const output = renderProjectHeader({ displayName: "utils", result: SKIPPED_RESULT });
		const plain = stripVTControlCharacters(output);

		expect(plain).toContain("1 passed");
		expect(plain).toContain("2 skipped");
		expect(plain).toContain("12 tests");
	});

	it("should include duration when tests have timing", () => {
		expect.assertions(1);

		const output = renderProjectHeader({ displayName: "core", result: PASSING_RESULT });
		const plain = stripVTControlCharacters(output);

		expect(plain).toMatch(/\d+ms/);
	});

	it("should omit the duration suffix when every test has zero duration", () => {
		expect.assertions(1);

		const result: JestResult = {
			...PASSING_RESULT,
			testResults: PASSING_RESULT.testResults.map((file) => {
				return {
					...file,
					testResults: file.testResults.map((test) => ({ ...test, duration: 0 })),
				};
			}),
		};
		const output = renderProjectHeader({ displayName: "core", result }, false);

		expect(output).toBe("▶ core  1 passed (3 tests)");
	});

	// The header and the trailing `Test Files` row bucket the same files, so
	// this pins the empty-file case on both sides of the report.
	it("should count a file that collected no tests as passed", () => {
		expect.assertions(2);

		const output = renderProjectHeader({ displayName: "core", result: EMPTY_FILE_RESULT });
		const plain = stripVTControlCharacters(output);

		expect(plain).toContain("2 passed");
		expect(plain).not.toContain("skipped");
	});
});

describe("multi-project section", () => {
	const noColorOptions: FormatOptions = { ...defaultOptions, color: false };

	it("should show header followed by file summaries", () => {
		expect.assertions(3);

		const output = renderProject(
			{
				displayName: "core",
				result: PASSING_RESULT,
			},
			noColorOptions,
		);

		expect(output).toContain("▶ core");
		expect(output).toContain("utils.spec.ts");
		expect(output).toContain("✓");
	});

	it("should include failure details for failing tests", () => {
		expect.assertions(2);

		const output = renderProject(
			{
				displayName: "auth",
				result: FAILING_RESULT,
			},
			noColorOptions,
		);

		expect(output).toContain("▶ auth");
		expect(output).toContain("player.spec.ts");
	});

	it("should include exec error details", () => {
		expect.assertions(2);

		const output = renderProject(
			{
				displayName: "broken",
				result: EXEC_ERROR_RESULT,
			},
			noColorOptions,
		);

		expect(output).toContain("▶ broken");
		expect(output).toContain("unit-menu-app");
	});

	it("should honor caller-supplied slowTestThreshold for duration coloring", () => {
		expect.assertions(1);

		const result = SLOW_TEST_RESULT;
		const output = renderProject(
			{
				displayName: "core",
				result,
			},
			{ ...defaultOptions, color: true, slowTestThreshold: 50 },
		);

		expect(output).toContain("[33m 100[2mms[22m[39m");
	});

	describe("game output", () => {
		const gameOutput = JSON.stringify([
			{ message: "materializing auth", messageType: 0, timestamp: 1 },
			{ message: "Infinite yield possible on 'Config'", messageType: 2, timestamp: 2 },
			{ message: "first line\nsecond line", messageType: 3, timestamp: 3 },
		]);

		it("should render a failing project's game output below its failures", () => {
			expect.assertions(5);

			const output = renderProject(
				{
					displayName: "auth",
					gameOutput,
					result: FAILING_RESULT,
				},
				noColorOptions,
			);

			expect(output).toContain("  Game output:");
			expect(output).toContain("    materializing auth");
			expect(output).toContain("    Infinite yield possible on 'Config'");
			expect(output).toContain("    first line\n    second line");
			expect(output.indexOf("Game output:")).toBeGreaterThan(output.lastIndexOf("[2/2]"));
		});

		it("should colour warnings and errors by message type", () => {
			expect.assertions(3);

			const output = renderProject(
				{
					displayName: "auth",
					gameOutput,
					result: FAILING_RESULT,
				},
				{ ...defaultOptions, color: true },
			);

			expect(output).toContain("    materializing auth");
			expect(output).toContain(`    ${color.yellow("Infinite yield possible on 'Config'")}`);
			expect(output).toContain(
				`    ${color.red("first line")}\n    ${color.red("second line")}`,
			);
		});

		it("should render game output for a project whose suite never ran", () => {
			expect.assertions(1);

			const output = renderProject(
				{
					displayName: "broken",
					gameOutput,
					result: EXEC_ERROR_RESULT,
				},
				noColorOptions,
			);

			expect(output).toContain("  Game output:\n    materializing auth");
		});

		it("should not render game output for a passing project", () => {
			expect.assertions(1);

			const output = renderProject(
				{
					displayName: "core",
					gameOutput,
					result: PASSING_RESULT,
				},
				noColorOptions,
			);

			expect(output).not.toContain("Game output");
		});

		it("should not render the block when a failing project printed nothing", () => {
			expect.assertions(1);

			const output = renderProject(
				{
					displayName: "auth",
					result: FAILING_RESULT,
				},
				noColorOptions,
			);

			expect(output).not.toContain("Game output");
		});
	});
});

describe(formatMultiProjectResult, () => {
	const noColorOptions: FormatOptions = { ...defaultOptions, color: false };

	// --bail stops the run partway, so the report has to say the packages it
	// shows are not the whole selection.
	it("should report how far a bailed run got", () => {
		expect.assertions(1);

		const output = formatMultiProjectResult({
			options: { ...noColorOptions, bail: { notRun: 3, ran: 2 } },
			projects: [
				{ displayName: "core", result: PASSING_RESULT },
				{ displayName: "integration", result: PASSING_RESULT },
			],
			timing: TIMING,
		});

		expect(output).toContain("Bailed  after 2 packages, 3 not run");
	});

	it("should say package, singular, when a bail stopped after one", () => {
		expect.assertions(1);

		const output = formatMultiProjectResult({
			options: { ...noColorOptions, bail: { notRun: 1, ran: 1 } },
			projects: [{ displayName: "core", result: PASSING_RESULT }],
			timing: TIMING,
		});

		expect(output).toContain("Bailed  after 1 package, 1 not run");
	});

	it("should leave the bail line out of a run that did not bail", () => {
		expect.assertions(1);

		const output = formatMultiProjectResult({
			options: noColorOptions,
			projects: [{ displayName: "core", result: PASSING_RESULT }],
			timing: TIMING,
		});

		expect(output).not.toContain("Bailed");
	});

	it("should group files under project headers with combined summary", () => {
		expect.assertions(5);

		const output = formatMultiProjectResult({
			options: noColorOptions,
			projects: [
				{ displayName: "core", result: PASSING_RESULT },
				{ displayName: "integration", result: PASSING_RESULT },
			],
			timing: TIMING,
		});

		expect(output).toContain("▶ core");
		expect(output).toContain("▶ integration");
		expect(output).toContain("Test Files");
		expect(output).toContain("6 passed");
		// The run header is emitted at the start of the run, not by the
		// end-of-run formatter.
		expect(output).not.toContain("RUN");
	});

	it("should show failure details within project sections", () => {
		expect.assertions(4);

		const output = formatMultiProjectResult({
			options: noColorOptions,
			projects: [
				{ displayName: "core", result: PASSING_RESULT },
				{ displayName: "auth", result: FAILING_RESULT },
			],
			timing: TIMING,
		});

		expect(output).toContain("▶ core");
		expect(output).toContain("▶ auth");
		expect(output).toContain("should have health");
		expect(output).toContain("Test Files");
	});

	it("should show failures from multiple projects", () => {
		expect.assertions(3);

		const output = formatMultiProjectResult({
			options: noColorOptions,
			projects: [
				{ displayName: "a", result: FAILING_RESULT },
				{ displayName: "b", result: MIXED_RESULT },
			],
			timing: TIMING,
		});

		expect(output).toContain("▶ a");
		expect(output).toContain("▶ b");
		expect(output).toContain("Tests");
	});

	it("should aggregate unchecked across projects into a single obsolete count", () => {
		expect.assertions(2);

		const projectA = passingFileResult({
			snapshot: {
				added: 0,
				didUpdate: true,
				matched: 1,
				total: 1,
				unchecked: 2,
				unmatched: 0,
				updated: 0,
			},
			testFilePath: "a.spec.ts",
		});

		const projectB = passingFileResult({
			snapshot: {
				added: 0,
				didUpdate: false,
				matched: 1,
				total: 1,
				unchecked: 3,
				unmatched: 0,
				updated: 0,
			},
			testFilePath: "b.spec.ts",
		});

		const snapshotLine = renderSnapshotLine(projectA, projectB);

		expect(snapshotLine).toMatch(/5 obsolete/);
		expect(snapshotLine).toMatch(/2 passed.*\(2\)/);
	});

	it("should aggregate snapshot counts across projects including obsolete", () => {
		expect.assertions(3);

		const projectA = passingFileResult({
			snapshot: {
				added: 0,
				matched: 1,
				total: 1,
				unchecked: 1,
				unmatched: 0,
				updated: 0,
			},
			testFilePath: "a.spec.ts",
		});

		const projectB = passingFileResult({
			snapshot: {
				added: 1,
				matched: 2,
				total: 3,
				unchecked: 1,
				unmatched: 0,
				updated: 0,
			},
			testFilePath: "b.spec.ts",
		});

		const snapshotLine = renderSnapshotLine(projectA, projectB);

		expect(snapshotLine).toMatch(/2 obsolete/);
		expect(snapshotLine).toMatch(/1 written/);
		expect(snapshotLine).toMatch(/3 passed.*\(4\)/);
	});

	it("should keep each failing project's game output under its own section", () => {
		expect.assertions(3);

		const output = formatMultiProjectResult({
			options: noColorOptions,
			projects: [
				{
					displayName: "auth",
					gameOutput: JSON.stringify([
						{ message: "auth says hi", messageType: 0, timestamp: 1 },
					]),
					result: FAILING_RESULT,
				},
				{
					displayName: "core",
					gameOutput: JSON.stringify([
						{ message: "core says hi", messageType: 0, timestamp: 2 },
					]),
					result: PASSING_RESULT,
				},
			],
			timing: TIMING,
		});

		const authSection = output.slice(output.indexOf("▶ auth"), output.indexOf("▶ core"));

		expect(authSection).toContain("    auth says hi");
		expect(authSection).not.toContain("core says hi");
		expect(output).not.toContain("core says hi");
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

		const output = renderProjectHeader({ displayName: "core", result: PASSING_RESULT });
		const plain = stripVTControlCharacters(output);

		expect(plain).toMatchInlineSnapshot('"▶  core   1 passed (3 tests - 30ms)"');
	});

	it("should format project header for failing result", () => {
		expect.assertions(1);

		const output = renderProjectHeader({ displayName: "auth", result: FAILING_RESULT });
		const plain = stripVTControlCharacters(output);

		expect(plain).toMatchInlineSnapshot('"▶  auth   1 failed (3 tests - 18ms)"');
	});

	it("should format project header for skipped result", () => {
		expect.assertions(1);

		const output = renderProjectHeader({ displayName: "utils", result: SKIPPED_RESULT });
		const plain = stripVTControlCharacters(output);

		expect(plain).toMatchInlineSnapshot('"▶  utils   1 passed | 2 skipped (12 tests - 50ms)"');
	});

	it("should order project header buckets failed-first", () => {
		expect.assertions(1);

		const output = renderProjectHeader({ displayName: "game", result: MIXED_RESULT });
		const plain = stripVTControlCharacters(output);

		expect(plain).toContain("1 failed | 1 passed");
	});

	it("should format project section for passing result", () => {
		expect.assertions(1);

		const output = renderProject(
			{
				displayName: "core",
				result: PASSING_RESULT,
			},
			baseOptions,
		);

		expect(output).toMatchInlineSnapshot(`
			"▶ core  1 passed (3 tests - 30ms)
			 ✓ src/utils.spec.ts (3 tests - 30ms)"
		`);
	});

	it("should format project section for failing result", () => {
		expect.assertions(1);

		const output = renderProject(
			{
				displayName: "auth",
				result: FAILING_RESULT,
			},
			baseOptions,
		);

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

		const output = formatMultiProjectResult({
			options: baseOptions,
			projects: [
				{ displayName: "core", result: PASSING_RESULT },
				{ displayName: "integration", result: PASSING_RESULT },
			],
			timing: TIMING,
		});

		expect(output).toMatchInlineSnapshot(`
			"
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

		const output = formatMultiProjectResult({
			options: baseOptions,
			projects: [
				{ displayName: "core", result: PASSING_RESULT },
				{ displayName: "auth", result: FAILING_RESULT },
			],
			timing: TIMING,
		});

		expect(output).toMatchInlineSnapshot(`
			"
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

			 Test Files  1 failed | 1 passed (2)
			      Tests  2 failed | 4 passed (6)
			   Start at  22:13:20
			   Duration  250ms (upload 50ms, environment 50ms, tests 100ms, cli 50ms)"
		`);
	});

	it("should format multi-project result with skipped files in summary", () => {
		expect.assertions(3);

		const output = formatMultiProjectResult({
			options: baseOptions,
			projects: [
				{ displayName: "core", result: PASSING_RESULT },
				{ displayName: "utils", result: SKIPPED_RESULT },
			],
			timing: TIMING,
		});

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

		const output = formatMultiProjectResult({
			options: baseOptions,
			projects: [
				{ displayName: "core", result: withTodo },
				{ displayName: "utils", result: PASSING_RESULT },
			],
			timing: TIMING,
		});

		expect(output).toContain("6 passed");
		expect(output).not.toContain("todo");
	});

	it("should aggregate snapshots across multi-project results", () => {
		expect.assertions(2);

		const withSnapshot: JestResult = {
			...PASSING_RESULT,
			snapshot: { added: 0, matched: 3, total: 5, unmatched: 2, updated: 0 },
		};

		const output = formatMultiProjectResult({
			options: baseOptions,
			projects: [
				{ displayName: "core", result: withSnapshot },
				{ displayName: "utils", result: PASSING_RESULT },
			],
			timing: TIMING,
		});

		expect(output).toContain("Snapshots");
		expect(output).toContain("2 failed");
	});
});

describe("multi-project slowTestThreshold", () => {
	it("should honor caller-supplied slowTestThreshold for duration coloring", () => {
		expect.assertions(1);

		const result = SLOW_TEST_RESULT;
		const output = formatMultiProjectResult({
			options: {
				...defaultOptions,
				color: true,
				slowTestThreshold: 50,
			},
			projects: [{ displayName: "core", result }],
			timing: TIMING,
		});

		expect(output).toContain("[33m 100[2mms[22m[39m");
	});
});

describe("formatProjectSection failuresOnly", () => {
	it("should skip passing files when failuresOnly is true", () => {
		expect.assertions(2);

		const options: FormatOptions = {
			color: false,
			failuresOnly: true,
			rootDir: "/project",
			verbose: false,
			version: "1.0.0",
		};

		const output = renderProject(
			{
				displayName: "auth",
				result: MIXED_RESULT,
			},
			options,
		);

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

		const output = formatMultiProjectResult({
			options,
			projects: [
				{ displayName: "core", result: PASSING_RESULT },
				{ displayName: "auth", result: FAILING_RESULT },
			],
			timing: TIMING,
		});

		expect(output).toContain("View results.json");
		expect(output).toContain("View game.log");
	});
});

describe("test duration coloring", () => {
	function passingFile(duration: number): JestResult {
		return {
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
					testFilePath: "src/dur.spec.ts",
					testResults: [
						{
							ancestorTitles: ["Suite"],
							duration,
							failureMessages: [],
							fullName: "Suite is timed",
							status: "passed",
							title: "is timed",
						},
					],
				},
			],
		};
	}

	it("should color slow passing test duration yellow when over 300ms threshold", () => {
		expect.assertions(2);

		const formatted = formatResult({
			options: {
				...defaultOptions,
				color: true,
				verbose: true,
			},
			result: passingFile(450),
			timing: createTiming(500),
		});

		expect(formatted).toContain("[33m 450[2mms[22m[39m");
		expect(formatted).not.toContain("[32m 450");
	});

	it("should still color exactly 300ms green (strict > comparison)", () => {
		expect.assertions(2);

		const formatted = formatResult({
			options: {
				...defaultOptions,
				color: true,
				verbose: true,
			},
			result: passingFile(300),
			timing: createTiming(500),
		});

		expect(formatted).toContain("[32m 300[2mms[22m[39m");
		expect(formatted).not.toContain("[33m 300");
	});

	it("should omit the group duration when all tests have undefined duration", () => {
		expect.assertions(1);

		const fileResult: TestFileResult = {
			numFailingTests: 1,
			numPassingTests: 0,
			numPendingTests: 0,
			testFilePath: "src/no-dur.spec.ts",
			testResults: [
				{
					ancestorTitles: ["Suite"],
					duration: undefined,
					failureMessages: ["Expected: 1\nReceived: 2"],
					fullName: "Suite fails",
					status: "failed",
					title: "fails",
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

		const formatted = formatResult({
			options: {
				...defaultOptions,
				color: true,
			},
			result,
			timing: createTiming(500),
		});

		const plain = stripVTControlCharacters(formatted);

		expect(plain).not.toMatch(/❯ Suite \(.*?\) 0ms/);
	});

	it("should color the passed-file summary total ms", () => {
		expect.assertions(1);

		const fileResult: TestFileResult = {
			numFailingTests: 0,
			numPassingTests: 2,
			numPendingTests: 0,
			testFilePath: "src/file.spec.ts",
			testResults: [
				{
					ancestorTitles: ["Suite"],
					duration: 200,
					failureMessages: [],
					fullName: "Suite a",
					status: "passed",
					title: "a",
				},
				{
					ancestorTitles: ["Suite"],
					duration: 200,
					failureMessages: [],
					fullName: "Suite b",
					status: "passed",
					title: "b",
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

		const formatted = formatResult({
			options: {
				...defaultOptions,
				color: true,
			},
			result,
			timing: createTiming(500),
		});

		expect(formatted).toContain("[33m 400[2mms[22m[39m");
	});

	it("should render duration without ANSI coloring when color is disabled", () => {
		expect.assertions(2);

		const formatted = formatResult({
			options: {
				...defaultOptions,
				color: false,
				verbose: true,
			},
			result: passingFile(42),
			timing: createTiming(500),
		});

		expect(formatted).not.toContain("[");
		expect(formatted).toContain(" 42ms");
	});

	it("should color durations in failed-suite group lines and the group total", () => {
		expect.assertions(2);

		const fileResult: TestFileResult = {
			numFailingTests: 1,
			numPassingTests: 1,
			numPendingTests: 0,
			testFilePath: "src/grp.spec.ts",
			testResults: [
				{
					ancestorTitles: ["Suite"],
					duration: 50,
					failureMessages: [],
					fullName: "Suite fast pass",
					status: "passed",
					title: "fast pass",
				},
				{
					ancestorTitles: ["Suite"],
					duration: 500,
					failureMessages: ["Expected: 1\nReceived: 2"],
					fullName: "Suite slow fail",
					status: "failed",
					title: "slow fail",
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

		const formatted = formatResult({
			options: {
				...defaultOptions,
				color: true,
			},
			result,
			timing: createTiming(1000),
		});

		expect(formatted).toContain("[32m 50[2mms[22m[39m");
		expect(formatted).toContain("[33m 550[2mms[22m[39m");
	});

	it("should color fast passing test duration green with dim ms suffix", () => {
		expect.assertions(1);

		const formatted = formatResult({
			options: {
				...defaultOptions,
				color: true,
				verbose: true,
			},
			result: passingFile(42),
			timing: createTiming(500),
		});

		expect(formatted).toContain("[32m 42[2mms[22m[39m");
	});

	it("should treat duration above caller-supplied slowTestThreshold as slow", () => {
		expect.assertions(1);

		const formatted = formatResult({
			options: {
				...defaultOptions,
				color: true,
				slowTestThreshold: 50,
				verbose: true,
			},
			result: passingFile(100),
			timing: createTiming(500),
		});

		expect(formatted).toContain("[33m 100[2mms[22m[39m");
	});

	it("should treat duration below caller-supplied slowTestThreshold as fast", () => {
		expect.assertions(1);

		const formatted = formatResult({
			options: {
				...defaultOptions,
				color: true,
				slowTestThreshold: 500,
				verbose: true,
			},
			result: passingFile(400),
			timing: createTiming(500),
		});

		expect(formatted).toContain("[32m 400[2mms[22m[39m");
	});
});

describe("complete formatter contracts", () => {
	it("should render complete pass, skip, failure, and exec-error reports exactly", () => {
		expect.assertions(1);

		const reports = [PASSING_RESULT, SKIPPED_RESULT, FAILING_RESULT, EXEC_ERROR_RESULT].map(
			(result) => {
				return formatResult({
					options: { ...defaultOptions, color: false },
					result,
					timing: TIMING,
				});
			},
		);

		expect(reports).toMatchSnapshot();
	});
});

describe("multi-project package-relative failure detail", () => {
	it("should show file lines against the run root and failures against the package root", () => {
		expect.assertions(3);

		const result: JestResult = {
			...EXEC_ERROR_RESULT,
			numFailedTests: 1,
			numTotalTests: 1,
			testResults: [
				{
					numFailingTests: 1,
					numPassingTests: 0,
					numPendingTests: 0,
					testFilePath: "/ws/packages/a/src/fail.spec.luau",
					testResults: [
						{
							ancestorTitles: [],
							duration: 1,
							failureMessages: ["Expected: 2\nReceived: 1"],
							fullName: "fails",
							status: "failed",
							title: "fails",
						},
					],
				},
				{
					...EXEC_ERROR_RESULT.testResults[0]!,
					testFilePath: "/ws/packages/a/src/broken.spec.luau",
				},
			],
		};

		const output = stripVTControlCharacters(
			formatMultiProjectResult({
				options: { ...defaultOptions, color: false, rootDir: "/ws" },
				projects: [{ displayName: "a", result, rootDir: "/ws/packages/a" }],
				timing: TIMING,
			}),
		);

		expect(output).toContain("❯ packages/a/src/fail.spec.luau");
		expect(output).toContain("FAIL  src/fail.spec.luau > fails");
		expect(output).toContain("FAIL  src/broken.spec.luau\n");
	});
});
