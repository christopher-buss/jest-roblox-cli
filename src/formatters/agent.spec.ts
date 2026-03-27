import { fromPartial } from "@total-typescript/shoehorn";

import { describe, expect, it, vi } from "vitest";

import type { SourceSnippet } from "../source-mapper/index.ts";
import type { JestResult, TestCaseResult } from "../types/jest-result.ts";
import {
	EXEC_ERROR_RESULT,
	FAILING_RESULT,
	LOADSTRING_ERROR_RESULT,
	MIXED_RESULT,
	MIXED_WITH_EXEC_ERROR_RESULT,
	PASSING_RESULT,
	SKIPPED_RESULT,
	SNAPSHOT_FAILING_RESULT,
} from "./__fixtures__/results.ts";
import { type AgentOptions, formatAgent, formatAgentMultiProject } from "./agent.ts";

vi.mock(
	import("../source-mapper"),
	async (importOriginal: () => Promise<typeof import("../source-mapper")>) => {
		const original = await importOriginal();
		return {
			...original,
			getSourceSnippet: vi.fn<typeof original.getSourceSnippet>(original.getSourceSnippet),
		};
	},
);

const { getSourceSnippet } = await import("../source-mapper");
const mockedGetSourceSnippet = vi.mocked(getSourceSnippet);

function createTestCase(overrides: Partial<TestCaseResult> = {}): TestCaseResult {
	return {
		ancestorTitles: ["TestSuite"],
		duration: 10,
		failureMessages: [],
		fullName: "TestSuite should pass",
		status: "passed",
		title: "should pass",
		...overrides,
	};
}

function createResult(overrides: Partial<JestResult> = {}): JestResult {
	return {
		numFailedTests: 0,
		numPassedTests: 1,
		numPendingTests: 0,
		numTotalTests: 1,
		startTime: Date.now(),
		success: true,
		testResults: [
			{
				numFailingTests: 0,
				numPassingTests: 1,
				numPendingTests: 0,
				testFilePath: "src/example.spec.ts",
				testResults: [createTestCase()],
			},
		],
		...overrides,
	};
}

describe("formatAgent summary", () => {
	it("should show file and test counts when all tests pass", () => {
		expect.assertions(1);

		const result = createResult({ numPassedTests: 3, numTotalTests: 3 });
		const output = formatAgent(result, { maxFailures: 10, rootDir: "/project" });

		expect(output).toBe(" Test Files  1 passed (1)\n      Tests  3 passed (3)");
	});

	it("should show type errors line when typeErrorCount is 0", () => {
		expect.assertions(1);

		const result = createResult({ numPassedTests: 3, numTotalTests: 3 });
		const output = formatAgent(result, {
			maxFailures: 10,
			rootDir: "/project",
			typeErrorCount: 0,
		});

		expect(output).toContain("Type Errors  no errors");
	});

	it("should show singular error when typeErrorCount is 1", () => {
		expect.assertions(1);

		const result = createResult({ numPassedTests: 3, numTotalTests: 3 });
		const output = formatAgent(result, {
			maxFailures: 10,
			rootDir: "/project",
			typeErrorCount: 1,
		});

		expect(output).toContain("Type Errors  1 error");
	});

	it("should show type error count when typeErrorCount > 1", () => {
		expect.assertions(1);

		const result = createResult({ numPassedTests: 3, numTotalTests: 3 });
		const output = formatAgent(result, {
			maxFailures: 10,
			rootDir: "/project",
			typeErrorCount: 2,
		});

		expect(output).toContain("Type Errors  2 errors");
	});

	it("should omit type errors line when typeErrorCount is undefined", () => {
		expect.assertions(1);

		const result = createResult({ numPassedTests: 3, numTotalTests: 3 });
		const output = formatAgent(result, { maxFailures: 10, rootDir: "/project" });

		expect(output).not.toContain("Type Errors");
	});

	it("should show failed and passed file counts", () => {
		expect.assertions(1);

		const output = formatAgent(FAILING_RESULT, {
			maxFailures: 10,
			rootDir: "/project",
		});

		expect(output).toContain(" Test Files  1 failed (1)");
	});

	it("should show failed, passed, and skipped test counts", () => {
		expect.assertions(1);

		const output = formatAgent(MIXED_RESULT, {
			maxFailures: 10,
			rootDir: "/project",
		});

		expect(output).toContain("      Tests  1 failed | 4 passed | 1 skipped (6)");
	});

	it("should show only failed counts when nothing passes", () => {
		expect.assertions(1);

		const failedTest = createTestCase({
			failureMessages: ["Error"],
			status: "failed",
			title: "should fail",
		});
		const result = createResult({
			numFailedTests: 1,
			numPassedTests: 0,
			numTotalTests: 1,
			success: false,
			testResults: [
				{
					numFailingTests: 1,
					numPassingTests: 0,
					numPendingTests: 0,
					testFilePath: "/project/src/test.spec.ts",
					testResults: [failedTest],
				},
			],
		});

		const output = formatAgent(result, { maxFailures: 10, rootDir: "/project" });

		expect(output).toContain("      Tests  1 failed (1)");
	});

	it("should include exec errors in failed file count", () => {
		expect.assertions(1);

		const output = formatAgent(MIXED_WITH_EXEC_ERROR_RESULT, {
			maxFailures: 10,
			rootDir: "/project",
		});

		expect(output).toContain(" Test Files  1 failed | 1 passed (2)");
	});
});

describe("formatAgent file headers", () => {
	it("should show file header with test count and failure count", () => {
		expect.assertions(1);

		const output = formatAgent(FAILING_RESULT, {
			maxFailures: 10,
			rootDir: "/project",
		});

		expect(output).toContain(" ❯ src/player.spec.ts (3 tests | 2 failed)");
	});

	it("should list each failed test with x marker", () => {
		expect.assertions(2);

		const output = formatAgent(FAILING_RESULT, {
			maxFailures: 10,
			rootDir: "/project",
		});

		expect(output).toContain("   × should have health");
		expect(output).toContain("   × should be alive");
	});

	it("should include duration on failed test lines", () => {
		expect.assertions(1);

		const output = formatAgent(FAILING_RESULT, {
			maxFailures: 10,
			rootDir: "/project",
		});

		expect(output).toContain("   × should have health 5ms");
	});

	it("should omit duration when test duration is undefined", () => {
		expect.assertions(1);

		const failedTest = createTestCase({
			duration: undefined,
			failureMessages: ["Error"],
			status: "failed",
			title: "should work",
		});
		const result = createResult({
			numFailedTests: 1,
			numPassedTests: 0,
			numTotalTests: 1,
			success: false,
			testResults: [
				{
					numFailingTests: 1,
					numPassingTests: 0,
					numPendingTests: 0,
					testFilePath: "/project/src/test.spec.ts",
					testResults: [failedTest],
				},
			],
		});

		const output = formatAgent(result, { maxFailures: 10, rootDir: "/project" });

		expect(output).toContain("   × should work\n");
	});

	it("should show suite failed to run for exec errors", () => {
		expect.assertions(1);

		const output = formatAgent(EXEC_ERROR_RESULT, {
			maxFailures: 10,
			rootDir: "/project",
		});

		expect(output).toContain("(suite failed to run)");
	});

	it("should only show files with failures", () => {
		expect.assertions(2);

		const output = formatAgent(MIXED_RESULT, {
			maxFailures: 10,
			rootDir: "/project",
		});

		expect(output).toContain(" ❯ src/game.spec.ts");
		expect(output).not.toContain("src/utils.spec.ts");
	});
});

describe("formatAgent separator", () => {
	it("should show Failed Tests N separator before failure details", () => {
		expect.assertions(1);

		const output = formatAgent(FAILING_RESULT, {
			maxFailures: 10,
			rootDir: "/project",
		});

		expect(output).toContain("⎯⎯⎯ Failed Tests 2 ⎯⎯⎯");
	});

	it("should not show separator when all tests pass", () => {
		expect.assertions(1);

		const output = formatAgent(PASSING_RESULT, {
			maxFailures: 10,
			rootDir: "/project",
		});

		expect(output).not.toContain("Failed Tests");
	});
});

// --- Failure details ---

describe("formatAgent failure details", () => {
	it("should show FAIL with ancestor chain using > separator", () => {
		expect.assertions(1);

		const output = formatAgent(FAILING_RESULT, {
			maxFailures: 10,
			rootDir: "/project",
		});

		expect(output).toContain(" FAIL src/player.spec.ts > Player > should have health");
	});

	it("should show Expected/Received labels", () => {
		expect.assertions(2);

		const output = formatAgent(FAILING_RESULT, {
			maxFailures: 10,
			rootDir: "/project",
		});

		expect(output).toContain("Expected: 100");
		expect(output).toContain("Received: 0");
	});

	it("should render snapshot diff", () => {
		expect.assertions(2);

		const output = formatAgent(SNAPSHOT_FAILING_RESULT, {
			maxFailures: 10,
			rootDir: "/project",
		});

		expect(output).toContain("- Snapshot  - 2");
		expect(output).toContain('+   "health": 150,');
	});

	it("should not duplicate source location in snapshot diff", () => {
		expect.assertions(2);

		const result = createResult({
			numFailedTests: 1,
			numPassedTests: 0,
			success: false,
			testResults: [
				{
					numFailingTests: 1,
					numPassingTests: 0,
					numPendingTests: 0,
					testFilePath: "/project/src/traits.spec.ts",
					testResults: [
						createTestCase({
							ancestorTitles: ["trait data"],
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
						}),
					],
				},
			],
		});

		const output = formatAgent(result, {
			maxFailures: 10,
			rootDir: "/project",
			sourceMapper: fromPartial({
				mapFailureMessage: (message: string) => message,
				mapFailureWithLocations: () => {
					return {
						locations: [
							{
								luauLine: 41,
								luauPath: "out/traits.spec.luau",
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
				resolveTestFilePath: () => {},
			}),
		});

		expect(output).toContain(
			" FAIL src/traits.spec.ts:29 > trait data > Apex matches snapshot",
		);
		expect(output.match(/src\/traits\.spec\.ts:29/g)?.length).toBe(1);
	});

	it("should respect maxFailures limit", () => {
		expect.assertions(2);

		const failures = Array.from({ length: 5 }, (_, index) => {
			return createTestCase({
				failureMessages: [`Error ${index}`],
				status: "failed",
				title: `test ${index}`,
			});
		});

		const result = createResult({
			numFailedTests: 5,
			numPassedTests: 0,
			success: false,
			testResults: [
				{
					numFailingTests: 5,
					numPassingTests: 0,
					numPendingTests: 0,
					testFilePath: "/project/src/test.spec.ts",
					testResults: failures,
				},
			],
		});

		const output = formatAgent(result, { maxFailures: 2, rootDir: "/project" });

		expect(output).toContain("... 3 more failures omitted");
		expect(output.match(/ FAIL /g)?.length).toBe(2);
	});

	it("should show exec error message in failure details", () => {
		expect.assertions(2);

		const output = formatAgent(EXEC_ERROR_RESULT, {
			maxFailures: 10,
			rootDir: "/project",
		});

		expect(output).toContain(" FAIL ");
		expect(output).toContain("Require-by-string is not enabled");
	});

	it("should show hint for exec errors", () => {
		expect.assertions(1);

		const output = formatAgent(LOADSTRING_ERROR_RESULT, {
			maxFailures: 10,
			rootDir: "/project",
		});

		expect(output).toContain("LoadStringEnabled");
	});
});

describe("formatAgent snippets", () => {
	it("should show TS and Luau snippets when 1-2 failures", () => {
		expect.assertions(4);

		const tsSnippet: SourceSnippet = {
			failureLine: 10,
			lines: [
				{ content: "const health = getHealth();", num: 9 },
				{ content: "expect(health).toBe(100);", num: 10 },
				{ content: "});", num: 11 },
			],
		};
		const luauSnippet: SourceSnippet = {
			failureLine: 15,
			lines: [
				{ content: "local health = getHealth()", num: 14 },
				{ content: "expect(health).toBe(100)", num: 15 },
				{ content: "end)", num: 16 },
			],
		};

		mockedGetSourceSnippet.mockImplementation((options): SourceSnippet | undefined => {
			if (options.filePath.endsWith(".luau")) {
				return luauSnippet;
			}

			return options.filePath.endsWith(".ts") ? tsSnippet : undefined;
		});

		const failedTest = createTestCase({
			failureMessages: ["Expected: 100\nReceived: 0"],
			status: "failed",
			title: "should have health",
		});

		const result = createResult({
			numFailedTests: 1,
			numPassedTests: 0,
			numTotalTests: 1,
			success: false,
			testResults: [
				{
					numFailingTests: 1,
					numPassingTests: 0,
					numPendingTests: 0,
					testFilePath: "/project/src/player.spec.ts",
					testResults: [failedTest],
				},
			],
		});

		const output = formatAgent(result, {
			maxFailures: 10,
			rootDir: "/project",
			sourceMapper: fromPartial({
				mapFailureWithLocations: () => {
					return {
						locations: [
							{
								luauLine: 15,
								luauPath: "out/player.spec.luau",
								tsLine: 10,
								tsPath: "src/player.spec.ts",
							},
						],
						message: "src/player.spec.ts:10",
					};
				},
				resolveTestFilePath: () => {},
			}),
		});

		expect(output).toContain("TS  src/player.spec.ts:10");
		expect(output).toContain("> 10| expect(health).toBe(100);");
		expect(output).toContain("Luau  out/player.spec.luau:15");
		expect(output).toContain("> 15| expect(health).toBe(100)");
	});

	it("should use relative paths in snippet labels when source mapper returns absolute paths", () => {
		expect.assertions(2);

		const tsSnippet: SourceSnippet = {
			failureLine: 10,
			lines: [
				{ content: "const x = 1;", num: 9 },
				{ content: "expect(x).toBe(2);", num: 10 },
				{ content: "});", num: 11 },
			],
		};
		const luauSnippet: SourceSnippet = {
			failureLine: 15,
			lines: [
				{ content: "local x = 1", num: 14 },
				{ content: "expect(x).toBe(2)", num: 15 },
				{ content: "end)", num: 16 },
			],
		};

		mockedGetSourceSnippet.mockImplementation((options): SourceSnippet | undefined => {
			if (options.filePath.endsWith(".luau")) {
				return luauSnippet;
			}

			return options.filePath.endsWith(".ts") ? tsSnippet : undefined;
		});

		const failedTest = createTestCase({
			failureMessages: ["Expected: 1\nReceived: 2"],
			status: "failed",
			title: "should work",
		});

		const result = createResult({
			numFailedTests: 1,
			numPassedTests: 0,
			numTotalTests: 1,
			success: false,
			testResults: [
				{
					numFailingTests: 1,
					numPassingTests: 0,
					numPendingTests: 0,
					testFilePath: "D:/project/src/test.spec.ts",
					testResults: [failedTest],
				},
			],
		});

		const output = formatAgent(result, {
			maxFailures: 10,
			rootDir: "D:\\project",
			sourceMapper: fromPartial({
				mapFailureWithLocations: () => {
					return {
						locations: [
							{
								luauLine: 15,
								luauPath: "D:/project/out/test.spec.luau",
								tsLine: 10,
								tsPath: "D:/project/src/test.spec.ts",
							},
						],
						message: "D:/project/src/test.spec.ts:10",
					};
				},
				resolveTestFilePath: () => {},
			}),
		});

		expect(output).toContain("TS  src/test.spec.ts:10");
		expect(output).toContain("Luau  out/test.spec.luau:15");
	});

	it("should show TS snippet only when 3-5 failures", () => {
		expect.assertions(2);

		const tsSnippet: SourceSnippet = {
			failureLine: 10,
			lines: [
				{ content: "const x = 1;", num: 9 },
				{ content: "expect(x).toBe(2);", num: 10 },
				{ content: "});", num: 11 },
			],
		};

		mockedGetSourceSnippet.mockImplementation((options): SourceSnippet | undefined => {
			return options.filePath.endsWith(".ts") ? tsSnippet : undefined;
		});

		const failures = Array.from({ length: 3 }, (_, index) => {
			return createTestCase({
				failureMessages: ["Expected: 1\nReceived: 2"],
				status: "failed",
				title: `test ${index}`,
			});
		});

		const result = createResult({
			numFailedTests: 3,
			numPassedTests: 0,
			numTotalTests: 3,
			success: false,
			testResults: [
				{
					numFailingTests: 3,
					numPassingTests: 0,
					numPendingTests: 0,
					testFilePath: "/project/src/test.spec.ts",
					testResults: failures,
				},
			],
		});

		const output = formatAgent(result, {
			maxFailures: 10,
			rootDir: "/project",
			sourceMapper: fromPartial({
				mapFailureWithLocations: () => {
					return {
						locations: [
							{
								luauLine: 15,
								luauPath: "out/test.spec.luau",
								tsLine: 10,
								tsPath: "src/test.spec.ts",
							},
						],
						message: "src/test.spec.ts:10",
					};
				},
				resolveTestFilePath: () => {},
			}),
		});

		expect(output).toContain("> 10| expect(x).toBe(2);");
		expect(output).not.toContain("Luau");
	});

	it("should show no snippets when 6+ failures", () => {
		expect.assertions(2);

		const tsSnippet: SourceSnippet = {
			failureLine: 10,
			lines: [
				{ content: "const x = 1;", num: 9 },
				{ content: "expect(x).toBe(2);", num: 10 },
				{ content: "});", num: 11 },
			],
		};

		mockedGetSourceSnippet.mockReturnValue(tsSnippet);

		const failures = Array.from({ length: 6 }, (_, index) => {
			return createTestCase({
				failureMessages: ["Expected: 1\nReceived: 2"],
				status: "failed",
				title: `test ${index}`,
			});
		});

		const result = createResult({
			numFailedTests: 6,
			numPassedTests: 0,
			numTotalTests: 6,
			success: false,
			testResults: [
				{
					numFailingTests: 6,
					numPassingTests: 0,
					numPendingTests: 0,
					testFilePath: "/project/src/test.spec.ts",
					testResults: failures,
				},
			],
		});

		const output = formatAgent(result, {
			maxFailures: 10,
			rootDir: "/project",
			sourceMapper: fromPartial({
				mapFailureWithLocations: () => {
					return {
						locations: [
							{
								luauLine: 15,
								luauPath: "out/test.spec.luau",
								tsLine: 10,
								tsPath: "src/test.spec.ts",
							},
						],
						message: "src/test.spec.ts:10",
					};
				},
				resolveTestFilePath: () => {},
			}),
		});

		expect(output).not.toContain("expect(x).toBe(2)");
		expect(output).not.toContain("Luau");
	});

	it("should show luau snippet when mapped location has no tsPath", () => {
		expect.assertions(1);

		const luauSnippet: SourceSnippet = {
			failureLine: 15,
			lines: [
				{ content: "local health = getHealth()", num: 14 },
				{ content: "expect(health).toBe(100)", num: 15 },
				{ content: "end)", num: 16 },
			],
		};

		mockedGetSourceSnippet.mockReturnValue(luauSnippet);

		const failedTest = createTestCase({
			failureMessages: ["Expected: 100\nReceived: 0"],
			status: "failed",
			title: "should have health",
		});

		const result = createResult({
			numFailedTests: 1,
			numPassedTests: 0,
			success: false,
			testResults: [
				{
					numFailingTests: 1,
					numPassingTests: 0,
					numPendingTests: 0,
					testFilePath: "/project/src/player.spec.ts",
					testResults: [failedTest],
				},
			],
		});

		const output = formatAgent(result, {
			maxFailures: 10,
			rootDir: "/project",
			sourceMapper: fromPartial({
				mapFailureWithLocations: () => {
					return {
						locations: [
							{
								luauLine: 15,
								luauPath: "out/player.spec.luau",
							},
						],
						message: "out/player.spec.luau:15",
					};
				},
				resolveTestFilePath: () => {},
			}),
		});

		expect(output).toContain("> 15| expect(health).toBe(100)");
	});

	it("should show no snippet when luau-only source file is unreadable", () => {
		expect.assertions(1);

		mockedGetSourceSnippet.mockReturnValue(undefined);

		const failedTest = createTestCase({
			failureMessages: ["Expected: 100\nReceived: 0"],
			status: "failed",
			title: "should have health",
		});

		const result = createResult({
			numFailedTests: 1,
			numPassedTests: 0,
			success: false,
			testResults: [
				{
					numFailingTests: 1,
					numPassingTests: 0,
					numPendingTests: 0,
					testFilePath: "/project/src/player.spec.ts",
					testResults: [failedTest],
				},
			],
		});

		const output = formatAgent(result, {
			maxFailures: 10,
			rootDir: "/project",
			sourceMapper: fromPartial({
				mapFailureWithLocations: () => {
					return {
						locations: [
							{
								luauLine: 15,
								luauPath: "out/player.spec.luau",
							},
						],
						message: "out/player.spec.luau:15",
					};
				},
				resolveTestFilePath: () => {},
			}),
		});

		expect(output).not.toMatch(/> \d+\|/);
	});

	it("should show no snippet when fallback source file is unreadable", () => {
		expect.assertions(1);

		mockedGetSourceSnippet.mockReturnValue(undefined);

		const failedTest = createTestCase({
			failureMessages: ["Error: Expected 1 to equal 2\nsrc/math.spec.ts:10"],
			status: "failed",
			title: "should add numbers",
		});

		const result = createResult({
			numFailedTests: 1,
			numPassedTests: 0,
			success: false,
			testResults: [
				{
					numFailingTests: 1,
					numPassingTests: 0,
					numPendingTests: 0,
					testFilePath: "/project/src/math.spec.ts",
					testResults: [failedTest],
				},
			],
		});

		const output = formatAgent(result, {
			maxFailures: 10,
			rootDir: "/project",
			sourceMapper: fromPartial({
				mapFailureWithLocations: (message: string) => ({ locations: [], message }),
				resolveTestFilePath: () => {},
			}),
		});

		expect(output).not.toMatch(/> \d+\|/);
	});

	it("should show snippet from parsed location when no sourceMapper", () => {
		expect.assertions(2);

		const snippet: SourceSnippet = {
			failureLine: 10,
			lines: [
				{ content: "const x = 1;", num: 9 },
				{ content: "expect(x).toBe(2);", num: 10 },
				{ content: "const y = 3;", num: 11 },
			],
		};

		mockedGetSourceSnippet.mockReturnValueOnce(snippet);

		const failedTest = createTestCase({
			failureMessages: ["Error: Expected 1 to equal 2\nsrc/math.spec.ts:10"],
			status: "failed",
			title: "should add numbers",
		});

		const result = createResult({
			numFailedTests: 1,
			numPassedTests: 0,
			success: false,
			testResults: [
				{
					numFailingTests: 1,
					numPassingTests: 0,
					numPendingTests: 0,
					testFilePath: "/project/src/math.spec.ts",
					testResults: [failedTest],
				},
			],
		});

		const output = formatAgent(result, {
			maxFailures: 10,
			rootDir: "/project",
			sourceMapper: fromPartial({
				mapFailureWithLocations: (message: string) => ({ locations: [], message }),
				resolveTestFilePath: () => {},
			}),
		});

		expect(output).toContain("> 10| expect(x).toBe(2);");
		expect(output).toContain("  9| const x = 1;");
	});
});

describe("formatAgent log hints", () => {
	it("should show output file hint with size on failure", () => {
		expect.assertions(1);

		const output = formatAgent(FAILING_RESULT, {
			maxFailures: 10,
			outputFile: "/tmp/results.json",
			outputFileSize: 7168,
			rootDir: "/project",
		});

		expect(output).toContain("View /tmp/results.json for full Jest output (7kb)");
	});

	it("should show game output hint with size on failure", () => {
		expect.assertions(1);

		const output = formatAgent(FAILING_RESULT, {
			gameOutput: "/tmp/game.json",
			gameOutputSize: 12288,
			maxFailures: 10,
			rootDir: "/project",
		});

		expect(output).toContain("View /tmp/game.json for Roblox game logs (12kb)");
	});

	it("should show both hints when both configured", () => {
		expect.assertions(2);

		const output = formatAgent(FAILING_RESULT, {
			gameOutput: "/tmp/game.json",
			gameOutputSize: 512,
			maxFailures: 10,
			outputFile: "/tmp/results.json",
			outputFileSize: 7168,
			rootDir: "/project",
		});

		expect(output).toContain("View /tmp/results.json for full Jest output (7kb)");
		expect(output).toContain("View /tmp/game.json for Roblox game logs (512b)");
	});

	it("should not show hints on passing results", () => {
		expect.assertions(1);

		const output = formatAgent(PASSING_RESULT, {
			maxFailures: 10,
			outputFile: "/tmp/results.json",
			rootDir: "/project",
		});

		expect(output).not.toContain("View");
	});

	it("should not show hints when no paths configured", () => {
		expect.assertions(1);

		const output = formatAgent(FAILING_RESULT, {
			maxFailures: 10,
			rootDir: "/project",
		});

		expect(output).not.toContain("View");
	});

	it("should show hints without size when size is undefined", () => {
		expect.assertions(2);

		const output = formatAgent(FAILING_RESULT, {
			gameOutput: "/tmp/game.json",
			maxFailures: 10,
			outputFile: "/tmp/results.json",
			rootDir: "/project",
		});

		expect(output).toContain("View /tmp/results.json for full Jest output\n");
		expect(output).toContain("View /tmp/game.json for Roblox game logs\n");
	});
});

describe("formatAgent source mapping", () => {
	it("should show Luau location for Luau-only mapped location", () => {
		expect.assertions(1);

		const failedTest = createTestCase({
			failureMessages: ["Expected: 1\nReceived: 2"],
			status: "failed",
			title: "should work",
		});

		const result = createResult({
			numFailedTests: 1,
			numPassedTests: 0,
			success: false,
			testResults: [
				{
					numFailingTests: 1,
					numPassingTests: 0,
					numPendingTests: 0,
					testFilePath: "lib/test.spec.luau",
					testResults: [failedTest],
				},
			],
		});

		const output = formatAgent(result, {
			maxFailures: 10,
			rootDir: "/project",
			sourceMapper: fromPartial({
				mapFailureWithLocations: () => {
					return {
						locations: [{ luauLine: 5, luauPath: "lib/test.spec.luau" }],
						message: "lib/test.spec.luau:5",
					};
				},
				resolveTestFilePath: () => {},
			}),
		});

		expect(output).toContain(" FAIL lib/test.spec.luau:5 > TestSuite > should work");
	});

	it("should resolve DataModel testFilePath to filesystem path", () => {
		expect.assertions(2);

		const failedTest = createTestCase({
			failureMessages: ["Error: Expected 1 to equal 2"],
			status: "failed",
			title: "should compute correctly",
		});

		const result = createResult({
			numFailedTests: 1,
			numPassedTests: 0,
			success: false,
			testResults: [
				{
					numFailingTests: 1,
					numPassingTests: 0,
					numPendingTests: 0,
					testFilePath: "ReplicatedStorage/client/example/test.spec",
					testResults: [failedTest],
				},
			],
		});

		const output = formatAgent(result, {
			maxFailures: 10,
			rootDir: "/project",
			sourceMapper: fromPartial({
				mapFailureWithLocations: (message: string) => ({ locations: [], message }),
				resolveTestFilePath: () => "src/client/example/test.spec.ts",
			}),
		});

		expect(output).toContain("src/client/example/test.spec.ts");
		expect(output).not.toContain("ReplicatedStorage");
	});
});

describe("formatAgent edge cases", () => {
	it("should show FAIL without ancestors when ancestorTitles is empty", () => {
		expect.assertions(1);

		const failedTest = createTestCase({
			ancestorTitles: [],
			failureMessages: ["Error"],
			status: "failed",
			title: "should work",
		});

		const result = createResult({
			numFailedTests: 1,
			numPassedTests: 0,
			numTotalTests: 1,
			success: false,
			testResults: [
				{
					numFailingTests: 1,
					numPassingTests: 0,
					numPendingTests: 0,
					testFilePath: "/project/src/test.spec.ts",
					testResults: [failedTest],
				},
			],
		});

		const output = formatAgent(result, { maxFailures: 10, rootDir: "/project" });

		expect(output).toContain(" FAIL src/test.spec.ts > should work");
	});

	it("should preserve path when it does not start with rootDir", () => {
		expect.assertions(1);

		const failedTest = createTestCase({
			failureMessages: ["Error"],
			status: "failed",
			title: "should work",
		});

		const result = createResult({
			numFailedTests: 1,
			numPassedTests: 0,
			numTotalTests: 1,
			success: false,
			testResults: [
				{
					numFailingTests: 1,
					numPassingTests: 0,
					numPendingTests: 0,
					testFilePath: "other/path/test.spec.ts",
					testResults: [failedTest],
				},
			],
		});

		const output = formatAgent(result, { maxFailures: 10, rootDir: "/project" });

		expect(output).toContain("other/path/test.spec.ts");
	});

	it("should make absolute source-mapped paths relative", () => {
		expect.assertions(2);

		const failedTest = createTestCase({
			failureMessages: ["Error"],
			status: "failed",
			title: "should work",
		});

		const result = createResult({
			numFailedTests: 1,
			numPassedTests: 0,
			numTotalTests: 1,
			success: false,
			testResults: [
				{
					numFailingTests: 1,
					numPassingTests: 0,
					numPendingTests: 0,
					testFilePath: "ReplicatedStorage/test",
					testResults: [failedTest],
				},
			],
		});

		const output = formatAgent(result, {
			maxFailures: 10,
			rootDir: "D:\\roblox\\project",
			sourceMapper: fromPartial({
				mapFailureWithLocations: (message: string) => ({ locations: [], message }),
				resolveTestFilePath: () => "D:/roblox/project/src/test.spec.ts",
			}),
		});

		expect(output).toContain("src/test.spec.ts");
		expect(output).not.toContain("D:/roblox");
	});

	it("should make paths relative when both use forward slashes", () => {
		expect.assertions(2);

		const failedTest = createTestCase({
			failureMessages: ["Error"],
			status: "failed",
			title: "should work",
		});

		const result = createResult({
			numFailedTests: 1,
			numPassedTests: 0,
			numTotalTests: 1,
			success: false,
			testResults: [
				{
					numFailingTests: 1,
					numPassingTests: 0,
					numPendingTests: 0,
					testFilePath: "ReplicatedStorage/test",
					testResults: [failedTest],
				},
			],
		});

		const output = formatAgent(result, {
			maxFailures: 10,
			rootDir: "D:/roblox/project",
			sourceMapper: fromPartial({
				mapFailureWithLocations: (message: string) => ({ locations: [], message }),
				resolveTestFilePath: () => "D:/roblox/project/src/test.spec.ts",
			}),
		});

		expect(output).toContain("src/test.spec.ts");
		expect(output).not.toContain("D:/roblox");
	});
});

describe("formatAgent loadstring hint", () => {
	it("should show hint when loadstring is not available", () => {
		expect.assertions(2);

		const output = formatAgent(LOADSTRING_ERROR_RESULT, {
			maxFailures: 10,
			rootDir: "/project",
		});

		expect(output).toContain("loadstring() is not available");
		expect(output).toContain("LoadStringEnabled");
	});
});

describe("formatAgent snapshots", () => {
	const baseOptions: AgentOptions = {
		maxFailures: 10,
		rootDir: "/project",
	};

	it("should format passing results", () => {
		expect.assertions(1);

		const output = formatAgent(PASSING_RESULT, baseOptions);

		expect(output).toMatchInlineSnapshot(`
			" Test Files  1 passed (1)
			      Tests  3 passed (3)"
		`);
	});

	it("should format failing results", () => {
		expect.assertions(1);

		const output = formatAgent(FAILING_RESULT, baseOptions);

		expect(output).toMatchInlineSnapshot(`
			" ❯ src/player.spec.ts (3 tests | 2 failed)
			   × should have health 5ms
			   × should be alive 3ms

			⎯⎯⎯ Failed Tests 2 ⎯⎯⎯

			 FAIL src/player.spec.ts > Player > should have health
			Expected: 100
			Received: 0

			 FAIL src/player.spec.ts > Player > should be alive
			Expected: true
			Received: false

			 Test Files  1 failed (1)
			      Tests  2 failed | 1 passed (3)"
		`);
	});

	it("should format mixed results", () => {
		expect.assertions(1);

		const output = formatAgent(MIXED_RESULT, baseOptions);

		expect(output).toMatchInlineSnapshot(`
			" ❯ src/game.spec.ts (4 tests | 1 failed)
			   × should end 8ms

			⎯⎯⎯ Failed Tests 1 ⎯⎯⎯

			 FAIL src/game.spec.ts > Game > should end
			Expected: "ended"
			Received: "running"

			 Test Files  1 failed | 1 passed (2)
			      Tests  1 failed | 4 passed | 1 skipped (6)"
		`);
	});

	it("should format exec-error-only result", () => {
		expect.assertions(1);

		const output = formatAgent(EXEC_ERROR_RESULT, baseOptions);

		expect(output).toMatchInlineSnapshot(`
			" ❯ shared/react/features/windows/__tests__/unit-menu-app.test (suite failed to run)

			⎯⎯⎯ Failed Tests 1 ⎯⎯⎯

			 FAIL shared/react/features/windows/__tests__/unit-menu-app.test
			Require-by-string is not enabled for use inside Jest at this time.

			 Test Files  1 failed (1)
			      Tests   (0)"
		`);
	});

	it("should format mixed passing + exec-error result", () => {
		expect.assertions(1);

		const output = formatAgent(MIXED_WITH_EXEC_ERROR_RESULT, baseOptions);

		expect(output).toMatchInlineSnapshot(`
			" ❯ src/broken.spec.ts (suite failed to run)

			⎯⎯⎯ Failed Tests 1 ⎯⎯⎯

			 FAIL src/broken.spec.ts
			Require-by-string is not enabled for use inside Jest at this time.

			 Test Files  1 failed | 1 passed (2)
			      Tests  3 passed (3)"
		`);
	});
});

describe(formatAgentMultiProject, () => {
	const baseOptions: AgentOptions = { maxFailures: 10, rootDir: "/project" };

	it("should group passing projects with headers and combined summary", () => {
		expect.assertions(1);

		const output = formatAgentMultiProject(
			[
				{ displayName: "core", result: PASSING_RESULT },
				{ displayName: "utils", result: PASSING_RESULT },
			],
			baseOptions,
		);

		expect(output).toMatchInlineSnapshot(`
			"▶ core  1 passed (3 tests)
			▶ utils  1 passed (3 tests)
			 Test Files  2 passed (2)
			      Tests  6 passed (6)"
		`);
	});

	it("should show failure details across projects", () => {
		expect.assertions(4);

		const output = formatAgentMultiProject(
			[
				{ displayName: "core", result: PASSING_RESULT },
				{ displayName: "auth", result: FAILING_RESULT },
			],
			baseOptions,
		);

		expect(output).toContain("▶ core  1 passed (3 tests)");
		expect(output).toContain("▶ auth  1 failed (3 tests)");
		expect(output).toContain("Failed Tests 2");
		expect(output).toContain("1 failed | 1 passed (2)");
	});

	it("should show exec errors from multiple projects", () => {
		expect.assertions(3);

		const output = formatAgentMultiProject(
			[
				{ displayName: "core", result: PASSING_RESULT },
				{ displayName: "broken", result: EXEC_ERROR_RESULT },
			],
			baseOptions,
		);

		expect(output).toContain("▶ broken  1 failed (0 tests)");
		expect(output).toContain("Failed Tests 1");
		expect(output).toContain("suite failed to run");
	});

	it("should show skipped files in project header and summary", () => {
		expect.assertions(3);

		const output = formatAgentMultiProject(
			[
				{ displayName: "core", result: PASSING_RESULT },
				{ displayName: "utils", result: SKIPPED_RESULT },
			],
			baseOptions,
		);

		expect(output).toContain("▶ utils  1 passed | 2 skipped (12 tests)");
		expect(output).toContain("2 passed | 2 skipped (4)");
		expect(output).toContain("8 passed | 7 skipped (15)");
	});

	it("should show hints in multi-project output", () => {
		expect.assertions(2);

		const output = formatAgentMultiProject(
			[
				{ displayName: "core", result: PASSING_RESULT },
				{ displayName: "auth", result: FAILING_RESULT },
			],
			{ ...baseOptions, gameOutput: "game.log", outputFile: "results.json" },
		);

		expect(output).toContain("View results.json for full Jest output");
		expect(output).toContain("View game.log for Roblox game logs");
	});

	it("should omit passed count when no tests pass", () => {
		expect.assertions(2);

		const output = formatAgentMultiProject(
			[
				{ displayName: "a", result: EXEC_ERROR_RESULT },
				{ displayName: "b", result: EXEC_ERROR_RESULT },
			],
			baseOptions,
		);

		expect(output).toContain("Tests   (0)");
		expect(output).not.toMatch(/\d+ passed/);
	});
});
