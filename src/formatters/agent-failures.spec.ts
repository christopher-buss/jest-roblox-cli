import { fromPartial } from "@total-typescript/shoehorn";

import { describe, expect, it, vi } from "vitest";

import { createTestCase, FAILING_RESULT } from "#test/mocks/format-results.ts";
import { createSingleFileResult, failingFileResult } from "#test/mocks/spec-format.ts";
import type { SourceMapper, SourceSnippet } from "../source-mapper/index.ts";
import type { JestResult, TestCaseResult } from "../types/jest-result-types.ts";
import {
	type FailureFormatOptions,
	formatFailures,
	type SourceSnippetReader,
} from "./agent-failures.ts";

const mockedGetSourceSnippet = vi.fn<SourceSnippetReader>();

/**
 * Snippet stub routed by the requested file's extension: `getSourceSnippet` is
 * called once per language per failure, so a test that only stubs one of them
 * gets `undefined` for the other.
 * @param filePath - Requested file.
 * @param snippets - Stubbed snippet per language.
 * @returns The stub for the file's language, or undefined.
 */
function snippetByExtension(
	filePath: string,
	snippets: { luau?: SourceSnippet; ts?: SourceSnippet },
): SourceSnippet | undefined {
	if (filePath.endsWith(".luau")) {
		return snippets.luau;
	}

	return filePath.endsWith(".ts") ? snippets.ts : undefined;
}

function renderFailures(result: JestResult, options: FailureFormatOptions): string {
	return formatFailures({ options, result, totalFailures: result.numFailedTests }).join("\n");
}

const TEST_SPEC_MAPPED = {
	locations: [
		{ luauLine: 15, luauPath: "out/test.spec.luau", tsLine: 10, tsPath: "src/test.spec.ts" },
	],
	message: "src/test.spec.ts:10",
};

const PLAYER_LUAU_ONLY_MAPPED = {
	locations: [{ luauLine: 15, luauPath: "out/player.spec.luau" }],
	message: "out/player.spec.luau:15",
};

const HEALTH_FAILURE = {
	failureMessages: ["Expected: 100\nReceived: 0"],
	status: "failed",
	title: "should have health",
} satisfies Partial<TestCaseResult>;

const X_TS_SNIPPET: SourceSnippet = {
	failureLine: 10,
	lines: [
		{ content: "const x = 1;", num: 9 },
		{ content: "expect(x).toBe(2);", num: 10 },
		{ content: "});", num: 11 },
	],
};

function numberedFailures(count: number): Array<TestCaseResult> {
	return Array.from({ length: count }, (_, index) => {
		return createTestCase({
			failureMessages: ["Expected: 1\nReceived: 2"],
			status: "failed",
			title: `test ${index}`,
		});
	});
}

function stubSourceMapper(
	mapped?: ReturnType<SourceMapper["mapFailureWithLocations"]>,
): SourceMapper {
	return fromPartial({
		mapFailureWithLocations: (message: string) => mapped ?? { locations: [], message },
		resolveDisplayPath: (testFilePath: string) => testFilePath,
		resolveTestFilePath: () => {},
	});
}

describe(formatFailures, () => {
	it("should omit an unavailable Luau snippet after a mapped TypeScript snippet", () => {
		expect.assertions(2);

		mockedGetSourceSnippet.mockImplementation((options): SourceSnippet | undefined => {
			return snippetByExtension(options.filePath, {
				ts: { failureLine: 10, lines: [{ content: "expect(value).toBe(1);", num: 10 }] },
			});
		});
		const output = renderFailures(FAILING_RESULT, {
			getSourceSnippet: mockedGetSourceSnippet,
			maxFailures: 10,
			rootDir: "/project",
			sourceMapper: stubSourceMapper({
				locations: [
					{
						luauLine: 15,
						luauPath: "out/player.spec.luau",
						tsLine: 10,
						tsPath: "src/player.spec.ts",
					},
				],
				message: "src/player.spec.ts:10",
			}),
		});

		expect(output).toContain("TS  src/player.spec.ts:10");
		expect(output).not.toContain("Luau  out/player.spec.luau:15");
	});

	it("should show TS and Luau snippets when 1-2 failures", () => {
		expect.assertions(5);

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
			return snippetByExtension(options.filePath, { luau: luauSnippet, ts: tsSnippet });
		});

		const failedTest = createTestCase(HEALTH_FAILURE);

		const result = createSingleFileResult({
			numFailedTests: 2,
			numPassedTests: 0,
			numTotalTests: 2,
			success: false,
			testResults: [
				{
					numFailingTests: 2,
					numPassingTests: 0,
					numPendingTests: 0,
					testFilePath: "/project/src/player.spec.ts",
					testResults: [
						failedTest,
						{
							...failedTest,
							fullName: "Player should stay healthy",
							title: "should stay healthy",
						},
					],
				},
			],
		});

		const output = renderFailures(result, {
			getSourceSnippet: mockedGetSourceSnippet,
			maxFailures: 10,
			rootDir: "/project",
			sourceMapper: stubSourceMapper({
				locations: [
					{
						luauLine: 15,
						luauPath: "out/player.spec.luau",
						tsLine: 10,
						tsPath: "src/player.spec.ts",
					},
				],
				message: "fallback.spec.ts:999",
			}),
		});

		expect(output).toContain("TS  src/player.spec.ts:10");
		expect(output).toContain("> 10| expect(health).toBe(100);");
		expect(output).toContain("Luau  out/player.spec.luau:15");
		expect(output).toContain("> 15| expect(health).toBe(100)");
		expect(output).toMatchSnapshot();
	});

	it("should use relative paths in snippet labels when source mapper returns absolute paths", () => {
		expect.assertions(2);

		const tsSnippet = X_TS_SNIPPET;
		const luauSnippet: SourceSnippet = {
			failureLine: 15,
			lines: [
				{ content: "local x = 1", num: 14 },
				{ content: "expect(x).toBe(2)", num: 15 },
				{ content: "end)", num: 16 },
			],
		};

		mockedGetSourceSnippet.mockImplementation((options): SourceSnippet | undefined => {
			return snippetByExtension(options.filePath, { luau: luauSnippet, ts: tsSnippet });
		});

		const failedTest = createTestCase({
			failureMessages: ["Expected: 1\nReceived: 2"],
			status: "failed",
			title: "should work",
		});

		const result = failingFileResult("D:/project/src/test.spec.ts", [failedTest]);

		const output = renderFailures(result, {
			getSourceSnippet: mockedGetSourceSnippet,
			maxFailures: 10,
			rootDir: "D:\\project",
			sourceMapper: stubSourceMapper({
				locations: [
					{
						luauLine: 15,
						luauPath: "D:/project/out/test.spec.luau",
						tsLine: 10,
						tsPath: "D:/project/src/test.spec.ts",
					},
				],
				message: "D:/project/src/test.spec.ts:10",
			}),
		});

		expect(output).toContain("TS  src/test.spec.ts:10");
		expect(output).toContain("Luau  out/test.spec.luau:15");
	});

	it("should show TS snippet only when 3-5 failures", () => {
		expect.assertions(3);

		const tsSnippet = X_TS_SNIPPET;
		const luauSnippet: SourceSnippet = {
			failureLine: 15,
			lines: [{ content: "expect(x).toBe(2)", num: 15 }],
		};

		mockedGetSourceSnippet.mockImplementation((options): SourceSnippet | undefined => {
			return snippetByExtension(options.filePath, { luau: luauSnippet, ts: tsSnippet });
		});

		const failures = numberedFailures(5);

		const result = failingFileResult("/project/src/test.spec.ts", failures);

		const output = renderFailures(result, {
			getSourceSnippet: mockedGetSourceSnippet,
			maxFailures: 10,
			rootDir: "/project",
			sourceMapper: stubSourceMapper(TEST_SPEC_MAPPED),
		});

		expect(output).toContain("> 10| expect(x).toBe(2);");
		expect(output).not.toContain("Luau");
		expect(output).toMatchSnapshot();
	});

	it("should show no snippets when 6+ failures", () => {
		expect.assertions(3);

		const tsSnippet = X_TS_SNIPPET;

		mockedGetSourceSnippet.mockReturnValue(tsSnippet);

		const failures = numberedFailures(6);

		const result = failingFileResult("/project/src/test.spec.ts", failures);

		const output = renderFailures(result, {
			getSourceSnippet: mockedGetSourceSnippet,
			maxFailures: 10,
			rootDir: "/project",
			sourceMapper: stubSourceMapper(TEST_SPEC_MAPPED),
		});

		expect(output).not.toContain("expect(x).toBe(2)");
		expect(output).not.toContain("Luau");
		expect(output).toMatchSnapshot();
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

		const failedTest = createTestCase(HEALTH_FAILURE);

		const result = failingFileResult("/project/src/player.spec.ts", [failedTest]);

		const output = renderFailures(result, {
			getSourceSnippet: mockedGetSourceSnippet,
			maxFailures: 10,
			rootDir: "/project",
			sourceMapper: stubSourceMapper(PLAYER_LUAU_ONLY_MAPPED),
		});

		expect(output).toContain("> 15| expect(health).toBe(100)");
	});

	it("should show no snippet when luau-only source file is unreadable", () => {
		expect.assertions(1);

		mockedGetSourceSnippet.mockReturnValue(undefined);

		const failedTest = createTestCase(HEALTH_FAILURE);

		const result = failingFileResult("/project/src/player.spec.ts", [failedTest]);

		const output = renderFailures(result, {
			getSourceSnippet: mockedGetSourceSnippet,
			maxFailures: 10,
			rootDir: "/project",
			sourceMapper: stubSourceMapper(PLAYER_LUAU_ONLY_MAPPED),
		});

		expect(output).toMatchSnapshot();
	});

	it("should show no snippet when fallback source file is unreadable", () => {
		expect.assertions(1);

		mockedGetSourceSnippet.mockReturnValue(undefined);

		const failedTest = createTestCase({
			failureMessages: ["Error: Expected 1 to equal 2\nsrc/math.spec.ts:10"],
			status: "failed",
			title: "should add numbers",
		});

		const result = failingFileResult("/project/src/math.spec.ts", [failedTest]);

		const output = renderFailures(result, {
			getSourceSnippet: mockedGetSourceSnippet,
			maxFailures: 10,
			rootDir: "/project",
			sourceMapper: stubSourceMapper(),
		});

		expect(output).toMatchSnapshot();
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

		const result = failingFileResult("/project/src/math.spec.ts", [failedTest]);

		const output = renderFailures(result, {
			getSourceSnippet: mockedGetSourceSnippet,
			maxFailures: 10,
			rootDir: "/project",
			sourceMapper: stubSourceMapper(),
		});

		expect(output).toContain("> 10| expect(x).toBe(2);");
		expect(output).toContain("  9| const x = 1;");
	});
});
