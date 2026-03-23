import { fromPartial } from "@total-typescript/shoehorn";

import { describe, expect, it } from "vitest";

import type { SourceMapper } from "../source-mapper/index.ts";
import type { JestResult } from "../types/jest-result.ts";
import {
	EXEC_ERROR_RESULT,
	FAILING_RESULT,
	MIXED_RESULT,
	PASSING_RESULT,
} from "./__fixtures__/results.ts";
import {
	collectAnnotations,
	escapeData,
	escapeProperty,
	formatAnnotation,
	formatAnnotations,
	formatJobSummary,
	resolveGitHubActionsOptions,
} from "./github-actions.ts";

describe(escapeData, () => {
	it("should encode percent, carriage return, and newline", () => {
		expect.assertions(1);

		expect(escapeData("100% done\r\nNext line")).toBe("100%25 done%0D%0ANext line");
	});

	it("should pass through normal text unchanged", () => {
		expect.assertions(1);

		expect(escapeData("hello world")).toBe("hello world");
	});
});

describe(escapeProperty, () => {
	it("should encode percent, CR, LF, colon, and comma", () => {
		expect.assertions(1);

		expect(escapeProperty("a%b\r\nc:d,e")).toBe("a%25b%0D%0Ac%3Ad%2Ce");
	});

	it("should pass through normal text unchanged", () => {
		expect.assertions(1);

		expect(escapeProperty("hello world")).toBe("hello world");
	});
});

describe(formatAnnotation, () => {
	it("should produce ::error workflow command with file, line, col, and title", () => {
		expect.assertions(1);

		const result = formatAnnotation({
			col: 5,
			file: "src/test.ts",
			line: 10,
			message: "Expected 1 to be 2",
			title: "TestSuite > should work",
		});

		expect(result).toBe(
			"::error file=src/test.ts,line=10,col=5,title=TestSuite > should work::Expected 1 to be 2",
		);
	});

	it("should omit line and col when not provided", () => {
		expect.assertions(1);

		const result = formatAnnotation({
			file: "src/test.ts",
			message: "Suite failed to run",
			title: "Exec error",
		});

		expect(result).toBe("::error file=src/test.ts,title=Exec error::Suite failed to run");
	});

	it("should omit title when not provided", () => {
		expect.assertions(1);

		const result = formatAnnotation({
			file: "src/test.ts",
			line: 5,
			message: "Error occurred",
		});

		expect(result).toBe("::error file=src/test.ts,line=5::Error occurred");
	});
});

describe(collectAnnotations, () => {
	it("should return empty array for passing results", () => {
		expect.assertions(1);

		const annotations = collectAnnotations(PASSING_RESULT, {});

		expect(annotations).toStrictEqual([]);
	});

	it("should create annotation for failed test with mapped TS location", () => {
		expect.assertions(3);

		const sourceMapper: SourceMapper = fromPartial({
			mapFailureWithLocations: () => {
				return {
					locations: [
						{
							luauLine: 41,
							luauPath: "out/player.spec.luau",
							tsColumn: 3,
							tsLine: 29,
							tsPath: "src/player.spec.ts",
						},
					],
					message: "mapped message",
				};
			},
		});

		const annotations = collectAnnotations(FAILING_RESULT, { sourceMapper });

		expect(annotations).toHaveLength(2);
		expect(annotations[0]).toMatchObject({
			col: 3,
			file: "src/player.spec.ts",
			line: 29,
			title: "Player should have health",
		});
		expect(annotations[1]).toMatchObject({
			file: "src/player.spec.ts",
			title: "Player should be alive",
		});
	});

	it("should fall back to testFilePath when no sourceMapper", () => {
		expect.assertions(2);

		const annotations = collectAnnotations(FAILING_RESULT, {});

		expect(annotations).toHaveLength(2);
		expect(annotations[0]).toMatchObject({
			file: "src/player.spec.ts",
			title: "Player should have health",
		});
	});

	it("should create annotation for exec-error file", () => {
		expect.assertions(2);

		const annotations = collectAnnotations(EXEC_ERROR_RESULT, {});

		expect(annotations).toHaveLength(1);
		expect(annotations[0]).toMatchObject({
			file: "shared/react/features/windows/__tests__/unit-menu-app.test",
			title: "Test suite failed to run",
		});
	});

	it("should handle failed test with empty failureMessages and skip sourceMapper", () => {
		expect.assertions(2);

		const sourceMapper: SourceMapper = fromPartial({
			mapFailureWithLocations: () => {
				return {
					locations: [{ luauLine: 1, luauPath: "x.luau", tsLine: 1, tsPath: "x.ts" }],
					message: "mapped",
				};
			},
		});

		const result: JestResult = {
			numFailedTests: 1,
			numPassedTests: 0,
			numPendingTests: 0,
			numTotalTests: 1,
			startTime: 0,
			success: false,
			testResults: [
				{
					numFailingTests: 1,
					numPassingTests: 0,
					numPendingTests: 0,
					testFilePath: "src/test.spec.ts",
					testResults: [
						{
							ancestorTitles: [],
							failureMessages: [],
							fullName: "should fail",
							status: "failed",
							title: "should fail",
						},
					],
				},
			],
		};

		const annotations = collectAnnotations(result, { sourceMapper });

		expect(annotations).toHaveLength(1);
		// Falls back to testFilePath since no failure message to map
		expect(annotations[0]).toMatchObject({ file: "src/test.spec.ts", message: "" });
	});

	it("should fall back to testFilePath when mapper returns empty locations", () => {
		expect.assertions(1);

		const sourceMapper: SourceMapper = fromPartial({
			mapFailureWithLocations: () => ({ locations: [], message: "mapped" }),
		});

		const annotations = collectAnnotations(FAILING_RESULT, { sourceMapper });

		expect(annotations[0]).toMatchObject({ file: "src/player.spec.ts" });
	});

	it("should use Luau location when mapper returns no TS path", () => {
		expect.assertions(2);

		const sourceMapper: SourceMapper = fromPartial({
			mapFailureWithLocations: () => {
				return {
					locations: [{ luauLine: 15, luauPath: "lib/test.spec.luau" }],
					message: "mapped",
				};
			},
		});

		const annotations = collectAnnotations(FAILING_RESULT, { sourceMapper });

		expect(annotations[0]).toMatchObject({
			file: "lib/test.spec.luau",
			line: 15,
		});
		expect(annotations[0]?.col).toBeUndefined();
	});

	it("should make paths relative to GITHUB_WORKSPACE", () => {
		expect.assertions(1);

		const result: JestResult = {
			numFailedTests: 1,
			numPassedTests: 0,
			numPendingTests: 0,
			numTotalTests: 1,
			startTime: 0,
			success: false,
			testResults: [
				{
					numFailingTests: 1,
					numPassingTests: 0,
					numPendingTests: 0,
					testFilePath: "/home/runner/work/project/src/test.spec.ts",
					testResults: [
						{
							ancestorTitles: [],
							failureMessages: ["error"],
							fullName: "should fail",
							status: "failed",
							title: "should fail",
						},
					],
				},
			],
		};

		const annotations = collectAnnotations(result, {
			workspace: "/home/runner/work/project",
		});

		expect(annotations[0]?.file).toBe("src/test.spec.ts");
	});
});

describe(formatAnnotations, () => {
	it("should join all annotations as workflow commands", () => {
		expect.assertions(2);

		const output = formatAnnotations(FAILING_RESULT, {});

		expect(output).toContain("::error file=src/player.spec.ts");
		expect(output.split("\n").filter((line) => line.startsWith("::error"))).toHaveLength(2);
	});

	it("should return empty string for passing results", () => {
		expect.assertions(1);

		expect(formatAnnotations(PASSING_RESULT, {})).toBe("");
	});
});

describe(formatJobSummary, () => {
	it("should render pass/fail/skip counts in stats section", () => {
		expect.assertions(3);

		const summary = formatJobSummary(PASSING_RESULT, {});

		expect(summary).toContain("3 passes");
		expect(summary).toContain("Test Files");
		expect(summary).toContain("Test Results");
	});

	it("should list failures with test names", () => {
		expect.assertions(2);

		const summary = formatJobSummary(FAILING_RESULT, {});

		expect(summary).toContain("Player should have health");
		expect(summary).toContain("Player should be alive");
	});

	it("should include file links when server/repo/sha available", () => {
		expect.assertions(1);

		const summary = formatJobSummary(FAILING_RESULT, {
			repository: "owner/repo",
			serverUrl: "https://github.com",
			sha: "abc123",
			workspace: "/work",
		});

		expect(summary).toContain("https://github.com/owner/repo/blob/abc123/src/player.spec.ts");
	});

	it("should work without file links", () => {
		expect.assertions(2);

		const summary = formatJobSummary(FAILING_RESULT, {});

		expect(summary).toContain("Player should have health");
		expect(summary).not.toContain("https://");
	});

	it("should include exec-error files in failure list", () => {
		expect.assertions(1);

		const summary = formatJobSummary(EXEC_ERROR_RESULT, {});

		expect(summary).toContain("Test suite failed to run");
	});

	it("should show pending count when present", () => {
		expect.assertions(1);

		const summary = formatJobSummary(MIXED_RESULT, {});

		expect(summary).toContain("1 skip");
	});

	it("should show todo count in other section", () => {
		expect.assertions(2);

		const result: JestResult = {
			...PASSING_RESULT,
			numTodoTests: 1,
		};

		const summary = formatJobSummary(result, {});

		expect(summary).toContain("1 todo");
		expect(summary).toContain("**Other**");
	});

	it("should combine pending and todo in other section", () => {
		expect.assertions(1);

		const result: JestResult = {
			...MIXED_RESULT,
			numTodoTests: 3,
		};

		const summary = formatJobSummary(result, {});

		expect(summary).toContain("1 skip · 3 todos · 4 total");
	});
});

describe("formatAnnotations snapshots", () => {
	it("should format failing result annotations", () => {
		expect.assertions(1);

		expect(formatAnnotations(FAILING_RESULT, {})).toMatchInlineSnapshot(`
			"::error file=src/player.spec.ts,title=Player should have health::expect(received).toBe(expected)%0A%0AExpected: 100%0AReceived: 0
			::error file=src/player.spec.ts,title=Player should be alive::expect(received).toBe(expected)%0A%0AExpected: true%0AReceived: false"
		`);
	});

	it("should format exec-error annotations", () => {
		expect.assertions(1);

		expect(formatAnnotations(EXEC_ERROR_RESULT, {})).toMatchInlineSnapshot(
			'"::error file=shared/react/features/windows/__tests__/unit-menu-app.test,title=Test suite failed to run::  ● Test suite failed to run%0A%0A    ReplicatedStorage.rbxts_include.node_modules.@rbxts-js.JestRuntime:1183: ReplicatedStorage.rbxts_include.node_modules.@rbxts-js.JestRuntime:1951: Require-by-string is not enabled for use inside Jest at this time.%0A%0A      ReplicatedStorage.rbxts_include.node_modules.@rbxts-js.JestRuntime:1183 function requireModule%0A      ReplicatedStorage.rbxts_include.node_modules.@rbxts-js.JestCircus:114%0A"',
		);
	});
});

describe("formatJobSummary snapshots", () => {
	it("should format passing result summary", () => {
		expect.assertions(1);

		expect(formatJobSummary(PASSING_RESULT, {})).toMatchInlineSnapshot(`
			"## Test Results

			### Summary

			- **Test Files**: ✅ **1 pass** · 1 total
			- **Test Results**: ✅ **3 passes** · 3 total
			"
		`);
	});

	it("should format failing result summary", () => {
		expect.assertions(1);

		expect(formatJobSummary(FAILING_RESULT, {})).toMatchInlineSnapshot(`
			"## Test Results

			### Summary

			- **Test Files**: ❌ **1 failure** · 1 total
			- **Test Results**: ❌ **2 failures** · ✅ **1 pass** · 3 total

			### Failures

			- **Player should have health** in src/player.spec.ts
			- **Player should be alive** in src/player.spec.ts
			"
		`);
	});

	it("should format mixed result summary", () => {
		expect.assertions(1);

		expect(formatJobSummary(MIXED_RESULT, {})).toMatchInlineSnapshot(`
			"## Test Results

			### Summary

			- **Test Files**: ❌ **1 failure** · ✅ **1 pass** · 2 total
			- **Test Results**: ❌ **1 failure** · ✅ **4 passes** · 5 total
			- **Other**: 1 skip · 1 total

			### Failures

			- **Game should end** in src/game.spec.ts
			"
		`);
	});

	it("should format failing result with file links", () => {
		expect.assertions(1);

		expect(
			formatJobSummary(FAILING_RESULT, {
				repository: "owner/repo",
				serverUrl: "https://github.com",
				sha: "abc123",
			}),
		).toMatchInlineSnapshot(`
			"## Test Results

			### Summary

			- **Test Files**: ❌ **1 failure** · 1 total
			- **Test Results**: ❌ **2 failures** · ✅ **1 pass** · 3 total

			### Failures

			- **Player should have health** in [src/player.spec.ts](https://github.com/owner/repo/blob/abc123/src/player.spec.ts)
			- **Player should be alive** in [src/player.spec.ts](https://github.com/owner/repo/blob/abc123/src/player.spec.ts)
			"
		`);
	});

	it("should format exec-error summary", () => {
		expect.assertions(1);

		expect(formatJobSummary(EXEC_ERROR_RESULT, {})).toMatchInlineSnapshot(`
			"## Test Results

			### Summary

			- **Test Files**: ❌ **1 failure** · 1 total
			- **Test Results**: 0 total

			### Failures

			- **Test suite failed to run** in shared/react/features/windows/__tests__/unit-menu-app.test
			"
		`);
	});
});

describe(resolveGitHubActionsOptions, () => {
	it("should use env var defaults when no user options provided", () => {
		expect.assertions(4);

		const result = resolveGitHubActionsOptions({}, undefined, {
			GITHUB_REPOSITORY: "owner/repo",
			GITHUB_SERVER_URL: "https://github.com",
			GITHUB_SHA: "abc123",
			GITHUB_STEP_SUMMARY: "/tmp/summary.md",
			GITHUB_WORKSPACE: "/home/runner/work",
		});

		expect(result.repository).toBe("owner/repo");
		expect(result.serverUrl).toBe("https://github.com");
		expect(result.sha).toBe("abc123");
		expect(result.workspace).toBe("/home/runner/work");
	});

	it("should override env vars with user options", () => {
		expect.assertions(2);

		const result = resolveGitHubActionsOptions(
			{
				jobSummary: {
					fileLinks: {
						repository: "custom/repo",
						workspacePath: "/custom/path",
					},
				},
			},
			undefined,
			{
				GITHUB_REPOSITORY: "owner/repo",
				GITHUB_WORKSPACE: "/home/runner/work",
			},
		);

		expect(result.repository).toBe("custom/repo");
		expect(result.workspace).toBe("/custom/path");
	});

	it("should pass through sourceMapper", () => {
		expect.assertions(1);

		const sourceMapper: SourceMapper = fromPartial({
			mapFailureWithLocations: () => ({ locations: [], message: "" }),
		});

		const result = resolveGitHubActionsOptions({}, sourceMapper, {});

		expect(result.sourceMapper).toBe(sourceMapper);
	});
});
