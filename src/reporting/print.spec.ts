import { fromPartial } from "@total-typescript/shoehorn";

import process from "node:process";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { FormatterEntry, ResolvedConfig } from "../config/schema.ts";
import type { ExecuteResult } from "../executor/executor-types.ts";
import type { ProjectResult } from "../run/run-types.ts";
import type { JestResult } from "../types/jest-result-types.ts";
import {
	type MultiOutputContext,
	printMultiResults,
	printSingleResults,
	type ResultRenderer,
} from "./print.ts";

const TIMING = { executionMs: 10, startTime: 0, testsMs: 5, totalMs: 100 };
const PRE_DISPATCH = { coverageMs: 7, stagingMs: 3 };

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return {
		...createResolvedConfig(),
		color: true,
		formatters: ["default"],
		rootDir: "/repo",
		testMatch: ["**/*.spec.ts"],
		testPathIgnorePatterns: [],
		...overrides,
	};
}

function makeJestResult(numberFailedTests = 0): JestResult {
	return fromPartial<JestResult>({ numFailedTests: numberFailedTests, testResults: [] });
}

function makeExecuteResult(): ExecuteResult {
	return fromPartial<ExecuteResult>({
		result: makeJestResult(),
		snapshotWriteFailures: 1,
		timing: TIMING,
	});
}

function makeRenderer(typecheckReport = "types\n") {
	return {
		formatAgentMultiProject: vi.fn<ResultRenderer["formatAgentMultiProject"]>(() => "agent"),
		formatExecuteOutput: vi.fn<ResultRenderer["formatExecuteOutput"]>(() => "execute"),
		formatMultiProjectResult: vi.fn<ResultRenderer["formatMultiProjectResult"]>(() => "multi"),
		formatResult: vi.fn<ResultRenderer["formatResult"]>(() => "result"),
		formatTypecheckReport: vi.fn<ResultRenderer["formatTypecheckReport"]>(
			() => typecheckReport,
		),
	};
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
		log: () => log.mock.calls.map(([line]) => String(line)),
		stderr: () => stderr.mock.calls.map(([chunk]) => String(chunk)).join(""),
		stdout: () => stdout.mock.calls.map(([chunk]) => String(chunk)).join(""),
	};
}

function makeProject(displayName: string): ProjectResult {
	return {
		displayColor: "red",
		displayName,
		result: fromPartial<ExecuteResult>({ gameOutput: "[]", result: makeJestResult() }),
	};
}

function makeMultiContext(overrides: Partial<MultiOutputContext> = {}): MultiOutputContext {
	return {
		...PRE_DISPATCH,
		config: makeConfig(),
		merged: makeExecuteResult(),
		projectResults: [makeProject("core")],
		renderer: makeRenderer(),
		...overrides,
	};
}

describe(printSingleResults, () => {
	it("should print nothing when silent", () => {
		expect.assertions(2);

		const output = captureOutput();
		const renderer = makeRenderer();

		printSingleResults(makeConfig({ silent: true }), {
			...PRE_DISPATCH,
			mergedResult: makeJestResult(),
			renderer,
			runtimeResult: makeExecuteResult(),
		});

		expect(output.log()).toStrictEqual([]);
		expect(renderer.formatExecuteOutput).not.toHaveBeenCalled();
	});

	it("should render the runtime result with pre-dispatch phases folded into the timing", () => {
		expect.assertions(2);

		const output = captureOutput();
		const renderer = makeRenderer();

		printSingleResults(makeConfig(), {
			...PRE_DISPATCH,
			mergedResult: makeJestResult(),
			renderer,
			runtimeResult: makeExecuteResult(),
		});

		expect(renderer.formatExecuteOutput).toHaveBeenCalledWith(
			expect.objectContaining({
				snapshotWriteFailures: 1,
				timing: { ...TIMING, coverageMs: 7, stagingMs: 3, totalMs: 110 },
				typeErrorCount: undefined,
			}),
		);
		expect(output.log()).toStrictEqual(["execute"]);
	});

	it("should skip an empty rendered output", () => {
		expect.assertions(1);

		const output = captureOutput();
		const renderer = makeRenderer();
		renderer.formatExecuteOutput.mockReturnValue("");

		printSingleResults(makeConfig(), {
			...PRE_DISPATCH,
			mergedResult: makeJestResult(),
			renderer,
			runtimeResult: makeExecuteResult(),
		});

		expect(output.log()).toStrictEqual([]);
	});

	it("should write the whole typecheck report on a typecheck-only run", () => {
		expect.assertions(2);

		const output = captureOutput();
		const renderer = makeRenderer();

		printSingleResults(makeConfig({ formatters: ["agent"] }), {
			...PRE_DISPATCH,
			mergedResult: makeJestResult(),
			renderer,
			typecheckResult: makeJestResult(2),
		});

		expect(renderer.formatTypecheckReport).toHaveBeenCalledWith(expect.anything(), {
			useColor: false,
		});
		expect(output.stdout()).toBe("types\n");
	});

	it("should render the merged result once with the default formatter", () => {
		expect.assertions(2);

		const output = captureOutput();
		const renderer = makeRenderer();

		printSingleResults(makeConfig(), {
			...PRE_DISPATCH,
			mergedResult: makeJestResult(),
			renderer,
			runtimeResult: makeExecuteResult(),
			typecheckResult: makeJestResult(2),
		});

		expect(renderer.formatResult).toHaveBeenCalledWith(
			expect.objectContaining({
				options: expect.objectContaining({ snapshotWriteFailures: 1, typeErrors: 2 }),
			}),
		);
		expect(output.log()).toStrictEqual(["result"]);
	});

	it.for<{ formatters: Array<FormatterEntry>; includeSummaryRows: boolean; useColor: boolean }>([
		{ formatters: ["agent"], includeSummaryRows: false, useColor: false },
		{ formatters: ["json"], includeSummaryRows: true, useColor: true },
	])(
		"should pair the runtime output with the type detail ($formatters)",
		({ formatters, includeSummaryRows, useColor }) => {
			expect.assertions(3);

			const output = captureOutput();
			const renderer = makeRenderer();

			printSingleResults(makeConfig({ formatters }), {
				...PRE_DISPATCH,
				mergedResult: makeJestResult(),
				renderer,
				runtimeResult: makeExecuteResult(),
				typecheckResult: makeJestResult(2),
			});

			expect(renderer.formatExecuteOutput).toHaveBeenCalledWith(
				expect.objectContaining({ typeErrorCount: 2 }),
			);
			expect(renderer.formatTypecheckReport).toHaveBeenCalledWith(expect.anything(), {
				includeSummaryRows,
				useColor,
			});
			expect(output.stderr()).toBe("types\n");
		},
	);

	it("should not write an empty type detail report", () => {
		expect.assertions(1);

		const output = captureOutput();

		printSingleResults(makeConfig({ formatters: ["json"] }), {
			...PRE_DISPATCH,
			mergedResult: makeJestResult(),
			renderer: makeRenderer(""),
			runtimeResult: makeExecuteResult(),
			typecheckResult: makeJestResult(),
		});

		expect(output.stderr()).toBe("");
	});
});

describe(printMultiResults, () => {
	it("should print nothing when silent", () => {
		expect.assertions(1);

		const output = captureOutput();

		printMultiResults(makeMultiContext({ config: makeConfig({ silent: true }) }));

		expect(output.log()).toStrictEqual([]);
	});

	it("should render every project with the default formatter", () => {
		expect.assertions(3);

		const output = captureOutput();
		const renderer = makeRenderer();

		printMultiResults(
			makeMultiContext({
				bail: { notRun: 1, ran: 1 },
				renderer,
				typecheckResult: makeJestResult(3),
			}),
		);

		expect(renderer.formatMultiProjectResult).toHaveBeenCalledWith({
			options: expect.objectContaining({
				bail: { notRun: 1, ran: 1 },
				snapshotWriteFailures: 1,
				typeErrors: 3,
			}),
			projects: [
				{
					displayColor: "red",
					displayName: "core",
					gameOutput: "[]",
					result: makeJestResult(),
				},
			],
			timing: { ...TIMING, coverageMs: 7, stagingMs: 3, totalMs: 110 },
		});
		expect(output.log()).toStrictEqual(["multi"]);
		expect(output.stderr()).toBe("");
	});

	it("should render the merged result through the JSON formatter", () => {
		expect.assertions(2);

		const output = captureOutput();
		const renderer = makeRenderer();

		printMultiResults(
			makeMultiContext({ config: makeConfig({ formatters: ["json"] }), renderer }),
		);

		expect(renderer.formatExecuteOutput).toHaveBeenCalledWith(
			expect.objectContaining({ typeErrorCount: undefined }),
		);
		expect(output.log()).toStrictEqual(["execute"]);
	});

	it.for<{ formatters: Array<FormatterEntry>; maxFailures: number }>([
		{ formatters: ["agent"], maxFailures: 10 },
		{ formatters: [["agent", { maxFailures: 4 }]], maxFailures: 4 },
	])(
		"should render agent output with max failures $maxFailures and the type detail",
		({ formatters, maxFailures }) => {
			expect.assertions(3);

			const output = captureOutput();
			const renderer = makeRenderer();

			printMultiResults(
				makeMultiContext({
					config: makeConfig({ formatters }),
					gameOutputHint: "game.log",
					outputFileHint: "out.json",
					renderer,
					typecheckResult: makeJestResult(2),
				}),
			);

			expect(renderer.formatAgentMultiProject).toHaveBeenCalledWith(
				expect.any(Array),
				expect.objectContaining({
					gameOutput: "game.log",
					maxFailures,
					outputFile: "out.json",
					rootDir: "/repo",
					typeErrorCount: 2,
				}),
			);
			expect(output.log()).toStrictEqual(["agent"]);
			expect(output.stderr()).toBe("types\n");
		},
	);
});
