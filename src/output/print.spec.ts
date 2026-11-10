import { fromPartial } from "@total-typescript/shoehorn";

import process from "node:process";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import type { FormatterEntry } from "../config/formatter-selection.ts";
import type { ExecuteResult } from "../executor/executor-types.ts";
import type { OutputSettings, ProjectResult } from "../results/run-result-types.ts";
import type { JestResult } from "../types/jest-result-types.ts";
import { printRunResults, type RunPrintContext } from "./print.ts";

const TIMING = { executionMs: 10, startTime: 0, testsMs: 5, totalMs: 100 };
const PRE_DISPATCH = { coverageMs: 7, stagingMs: 3 };

function makeSettings(overrides: Partial<OutputSettings> = {}): OutputSettings {
	return {
		collectCoverage: false,
		color: false,
		formatters: ["default"],
		perUnitGameOutput: false,
		perUnitOutputFile: false,
		rootDir: "/repo",
		showLuau: true,
		silent: false,
		verbose: false,
		...overrides,
	};
}

function makeJestResult(numberFailedTests = 0): JestResult {
	return {
		numFailedTests: numberFailedTests,
		numPassedTests: 1,
		numPendingTests: 0,
		numTodoTests: 0,
		numTotalTests: 1 + numberFailedTests,
		startTime: 0,
		success: numberFailedTests === 0,
		testResults: [
			{
				numFailingTests: numberFailedTests,
				numPassingTests: 1,
				numPendingTests: 0,
				testFilePath: "/repo/src/player.spec.ts",
				testResults: [
					{
						ancestorTitles: ["player"],
						duration: 1,
						failureMessages: [],
						fullName: "player spawns",
						status: "passed",
						title: "spawns",
					},
					...Array.from({ length: numberFailedTests }, (_, index) => {
						return {
							ancestorTitles: ["player"],
							duration: 1,
							failureMessages: [`boom ${index}`],
							fullName: `player explodes ${index}`,
							status: "failed" as const,
							title: `explodes ${index}`,
						};
					}),
				],
			},
		],
	};
}

function makeExecuteResult(numberFailedTests = 0): ExecuteResult {
	return fromPartial<ExecuteResult>({
		gameOutput: "[]",
		result: makeJestResult(numberFailedTests),
		snapshotWriteFailures: 1,
		timing: TIMING,
	});
}

function captureOutput() {
	const log = vi.spyOn(console, "log").mockReturnValue(undefined);
	const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
	const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
	onTestFinished(() => {
		log.mockRestore();
		stdout.mockRestore();
		stderr.mockRestore();
	});
	return {
		log: () =>
			log.mock.calls
				.map(([line]) => stripVTControlCharacters(String(line)))
				.join("\n")
				.replace(/^.*Start at.*\n/m, ""),
		stderr: () => stderr.mock.calls.map(([chunk]) => String(chunk)).join(""),
		stdout: () => stdout.mock.calls.map(([chunk]) => String(chunk)).join(""),
	};
}

function makeProject(displayName: string, numberFailedTests = 0): ProjectResult {
	return {
		displayColor: "red",
		displayName,
		result: makeExecuteResult(numberFailedTests),
	};
}

function makeContext(overrides: Partial<RunPrintContext> = {}): RunPrintContext {
	return {
		...PRE_DISPATCH,
		projectResults: [makeProject("core")],
		runtime: makeExecuteResult(),
		settings: makeSettings(),
		...overrides,
	};
}

describe(printRunResults, () => {
	it("should print nothing when silent", () => {
		expect.assertions(1);

		const output = captureOutput();

		printRunResults(makeContext({ settings: makeSettings({ silent: true }) }));

		expect(output.log()).toBe("");
	});

	it("should render every project with the default formatter", () => {
		expect.assertions(2);

		const output = captureOutput();

		printRunResults(
			makeContext({
				bail: { notRun: 1, ran: 1 },
				projectResults: [makeProject("core"), makeProject("server")],
				typecheckResult: makeJestResult(3),
			}),
		);

		expect(output.log()).toMatchInlineSnapshot(`
			"
			▶ core  1 passed (1 tests - 1ms)
			 ✓ src/player.spec.ts (1 tests - 1ms)

			▶ server  1 passed (1 tests - 1ms)
			 ✓ src/player.spec.ts (1 tests - 1ms)

			  Snapshot Write  1 failed
			 Test Files  2 passed (2)
			      Tests  2 passed (2)
			Type Errors  3 failed
			     Bailed  after 1 package, 1 not run
			   Duration  110ms (environment 5ms, tests 5ms, cli 90ms, staging 3ms, coverage 7ms)"
		`);
		expect(output.stderr()).toBe("");
	});

	it("should render the merged result as JSON relative to the root", () => {
		expect.assertions(1);

		const output = captureOutput();

		printRunResults(makeContext({ settings: makeSettings({ formatters: ["json"] }) }));

		expect(JSON.parse(output.log())).toStrictEqual({
			...makeJestResult(),
			testResults: [
				{ ...makeJestResult().testResults[0], testFilePath: "src/player.spec.ts" },
			],
		});
	});

	it.for<{ formatters: Array<FormatterEntry>; name: string }>([
		{ formatters: ["agent"], name: "default" },
		{ formatters: [["agent", { maxFailures: 1 }]], name: "one" },
	])(
		"should render agent output with $name max failures and the type detail",
		({ formatters }) => {
			expect.assertions(2);

			const output = captureOutput();

			printRunResults(
				makeContext({
					bail: { notRun: 1, ran: 1 },
					projectResults: [makeProject("core", 2)],
					settings: makeSettings({ formatters, gameOutput: "game.log", outputFile: "out.json" }),
					typecheckResult: makeJestResult(2),
				}),
			);

			expect(output.log()).toMatchSnapshot();
			expect(output.stderr()).toMatchSnapshot();
		},
	);
});

describe("printRunResults without a runtime job", () => {
	it.for([false, true])("should write the whole typecheck report with color=%s", (color) => {
		expect.assertions(2);

		const output = captureOutput();

		printRunResults(
			makeContext({
				projectResults: [],
				runtime: undefined,
				settings: makeSettings({ color }),
				typecheckResult: makeJestResult(1),
			}),
		);

		expect(stripVTControlCharacters(output.stdout())).toMatchSnapshot();
		expect(output.stdout() !== stripVTControlCharacters(output.stdout())).toBe(color);
	});

	it("should write the typecheck report without color for the agent formatter", () => {
		expect.assertions(1);

		const output = captureOutput();

		printRunResults(
			makeContext({
				projectResults: [],
				runtime: undefined,
				settings: makeSettings({ color: true, formatters: ["agent"] }),
				typecheckResult: makeJestResult(1),
			}),
		);

		expect(output.stdout()).toBe(stripVTControlCharacters(output.stdout()));
	});

	it("should print nothing without a Type Test result", () => {
		expect.assertions(1);

		const output = captureOutput();

		printRunResults(makeContext({ projectResults: [], runtime: undefined }));

		expect(output.stdout()).toBe("");
	});
});

describe("printRunResults type report beside the runtime output", () => {
	it("should write the summary rows to stderr for the json formatter", () => {
		expect.assertions(1);

		const output = captureOutput();

		printRunResults(
			makeContext({
				settings: makeSettings({ formatters: ["json"] }),
				typecheckResult: makeJestResult(),
			}),
		);

		expect(output.stderr()).toMatchInlineSnapshot(`
			"
			      Tests  1 passed (1)
			Type Errors  no errors
			"
		`);
	});

	it("should not write a clean agent type report", () => {
		expect.assertions(1);

		const output = captureOutput();

		printRunResults(
			makeContext({
				settings: makeSettings({ formatters: ["agent"] }),
				typecheckResult: makeJestResult(),
			}),
		);

		expect(output.stderr()).toBe("");
	});
});
