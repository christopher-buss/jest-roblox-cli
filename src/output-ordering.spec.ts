import { fromAny } from "@total-typescript/shoehorn";

import process from "node:process";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG, type ResolvedConfig } from "./config/schema.ts";
import type { MappedCoverageResult, MappedFileCoverage } from "./coverage-pipeline/mapper.ts";
import { outputMultiResult } from "./output.ts";
import type { WorkspaceRunResult } from "./run/types.ts";
import type { JestResult, TestCaseResult } from "./types/jest-result.ts";

// Unlike output.spec.ts (which mocks the formatters + coverage reporter to assert
// call ordering), this spec runs the live formatter and the real Istanbul text
// reporter so the snapshot shows the actual on-screen layout: the coverage report
// first, then the run summary, then the final status line.

function passingTest(index: number): TestCaseResult {
	return {
		ancestorTitles: ["inventory"],
		duration: 1,
		failureMessages: [],
		fullName: `inventory case ${index}`,
		status: "passed",
		title: `case ${index}`,
	};
}

function passingResult(): JestResult {
	return {
		numFailedTests: 0,
		numPassedTests: 5,
		numPendingTests: 0,
		numTodoTests: 0,
		numTotalTests: 5,
		startTime: 1000,
		success: true,
		testResults: [
			{
				numFailingTests: 0,
				numPassingTests: 5,
				numPendingTests: 0,
				testFilePath: "src/client/inventory.spec.ts",
				testResults: [0, 1, 2, 3, 4].map(passingTest),
			},
		],
	};
}

function mappedFile(overrides: Partial<MappedFileCoverage>): MappedFileCoverage {
	return {
		b: {},
		branchMap: {},
		f: { "0": 2 },
		fnMap: {
			"0": {
				name: "fn",
				loc: { end: { column: 1, line: 5 }, start: { column: 0, line: 1 } },
			},
		},
		path: "src/client/player.ts",
		s: { "0": 3, "1": 0, "2": 5 },
		statementMap: {
			"0": { end: { column: 20, line: 1 }, start: { column: 0, line: 1 } },
			"1": { end: { column: 15, line: 3 }, start: { column: 0, line: 3 } },
			"2": { end: { column: 10, line: 5 }, start: { column: 0, line: 5 } },
		},
		...overrides,
	};
}

// One file fully covered (hidden by skipFull), one partial (shown), so the agent
// table and the raw-counts totals line both have something to print.
function mixedCoverage(): MappedCoverageResult {
	return {
		files: {
			"src/client/inventory.ts": mappedFile({
				f: { "0": 5 },
				path: "src/client/inventory.ts",
				s: { "0": 5, "1": 2, "2": 3 },
			}),
			"src/client/player.ts": mappedFile({ path: "src/client/player.ts" }),
		},
	};
}

function makeConfig(): ResolvedConfig {
	return {
		...DEFAULT_CONFIG,
		collectCoverage: true,
		color: false,
		coverageReporters: ["text"],
		formatters: ["agent"],
		rootDir: "/test",
		testMatch: ["**/*.spec.ts"],
		testPathIgnorePatterns: [],
	};
}

function makeWorkspaceResult(): WorkspaceRunResult {
	return fromAny({
		coverageMapped: mixedCoverage(),
		merged: {},
		mode: "workspace",
		preCoverageMs: 0,
		projectResults: [
			{
				displayName: "client",
				result: {
					exitCode: 0,
					output: "",
					result: passingResult(),
					timing: { executionMs: 50, startTime: 1000, testsMs: 30, totalMs: 100 },
				},
			},
		],
	});
}

describe("agent-mode output ordering", () => {
	it("should render the run summary after the coverage report and above the status line", async () => {
		expect.assertions(1);

		const chunks: Array<string> = [];
		vi.spyOn(console, "log").mockImplementation((message: unknown) => {
			chunks.push(`${String(message)}\n`);
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			chunks.push(String(chunk));
			return true;
		});
		vi.spyOn(process.stderr, "write").mockReturnValue(true);

		await outputMultiResult(makeConfig(), makeWorkspaceResult());

		expect(stripVTControlCharacters(chunks.join(""))).toMatchInlineSnapshot(`
			"
			 % Coverage report from istanbul
			--------------|---------|----------|---------|---------|-------------------
			File          | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s 
			--------------|---------|----------|---------|---------|-------------------
			All files     |   83.33 |      100 |     100 |   83.33 |                   
			 player.ts    |   66.66 |      100 |     100 |   66.66 | 3                 
			--------------|---------|----------|---------|---------|-------------------
			Coverage: 83.33% stmts (5/6) | 100% branch (0/0) | 100% funcs (2/2) | 83.33% lines (5/6)
			▶ client  1 passed (5 tests)
			 Test Files  1 passed (1)
			      Tests  5 passed (5)
			 PASS 
			"
		`);
	});
});
