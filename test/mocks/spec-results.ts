import process from "node:process";
import type { MockInstance } from "vitest";
import { vi } from "vitest";

import type { ResolvedConfig } from "#src/config/resolved-config.ts";
import type { ExecuteResult } from "#src/executor/executor-types.ts";
import type { JestResult } from "#src/types/jest-result-types.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";

export interface OutputSpies {
	consoleError: MockedConsole;
	consoleLog: MockedConsole;
	stderr: MockedWrite;
	stdout: MockedWrite;
}

type MockedWrite = MockInstance<typeof process.stderr.write>;

type MockedConsole = MockInstance<typeof console.log>;

export function makeJestResult(overrides: Partial<JestResult> = {}): JestResult {
	return {
		numFailedTests: 0,
		numPassedTests: 1,
		numPendingTests: 0,
		numTodoTests: 0,
		numTotalTests: 1,
		startTime: 1000,
		success: true,
		testResults: [],
		...overrides,
	};
}

export function makeExecuteResult(overrides: Partial<ExecuteResult> = {}): ExecuteResult {
	return {
		exitCode: 0,
		result: makeJestResult(),
		timing: {
			executionMs: 100,
			startTime: 1000,
			testsMs: 50,
			totalMs: 200,
			uploadMs: 50,
		},
		...overrides,
	};
}

export function setupOutputSpies(): OutputSpies {
	return {
		consoleError: vi.spyOn(console, "error").mockReturnValue(undefined),
		consoleLog: vi.spyOn(console, "log").mockReturnValue(undefined),
		stderr: vi.spyOn(process.stderr, "write").mockReturnValue(true),
		stdout: vi.spyOn(process.stdout, "write").mockReturnValue(true),
	};
}

export function makeOutputConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return {
		...createResolvedConfig(),
		formatters: ["default"],
		rootDir: "/test",
		testMatch: ["**/*.spec.ts"],
		testPathIgnorePatterns: [],
		...overrides,
	};
}

export function makeBlockedResult(testFilePath: string, fullName: string): JestResult {
	return makeJestResult({
		success: false,
		testResults: [
			{
				gaps: {},
				numFailingTests: 0,
				numPassingTests: 1,
				numPendingTests: 0,
				testFilePath,
				testResults: [
					{
						ancestorTitles: [],
						failureMessages: [],
						fullName,
						gaps: { script: 1 },
						status: "passed",
						title: fullName,
					},
				],
			},
		],
	});
}
