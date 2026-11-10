import { describe, expect, it } from "vitest";

import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { ResolvedConfig } from "../config/resolved-config.ts";
import type { JestResult } from "../types/jest-result-types.ts";
import type { TimingResult } from "../types/timing-types.ts";
import { formatExecuteOutput } from "./format-output.ts";

const TIMING: TimingResult = { executionMs: 150, startTime: 0, testsMs: 100, totalMs: 250 };

const PASSING_RESULT: JestResult = {
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
			testFilePath: "src/utils.spec.ts",
			testResults: [
				{
					ancestorTitles: [],
					duration: 10,
					failureMessages: [],
					fullName: "adds",
					status: "passed",
					title: "adds",
				},
			],
		},
	],
};

const FAILING_RESULT: JestResult = {
	...PASSING_RESULT,
	numFailedTests: 1,
	numPassedTests: 0,
	success: false,
	testResults: [
		{
			numFailingTests: 1,
			numPassingTests: 0,
			numPendingTests: 0,
			testFilePath: "src/utils.spec.ts",
			testResults: [
				{
					ancestorTitles: [],
					duration: 10,
					failureMessages: ["Error: boom"],
					fullName: "adds",
					status: "failed",
					title: "adds",
				},
			],
		},
	],
};

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return {
		...createResolvedConfig(),
		color: false,
		formatters: ["default"],
		rootDir: "/repo",
		testMatch: ["**/*.spec.ts"],
		testPathIgnorePatterns: [],
		...overrides,
	};
}

function format(config: ResolvedConfig, result = PASSING_RESULT): string {
	return formatExecuteOutput({ config, result, timing: TIMING, version: "1.0.0" });
}

describe(formatExecuteOutput, () => {
	it("should print nothing when silent", () => {
		expect.assertions(1);

		expect(format(makeConfig({ formatters: ["json"], silent: true }))).toBe("");
	});

	it("should render the JSON formatter as the raw result", () => {
		expect.assertions(1);

		expect(JSON.parse(format(makeConfig({ formatters: ["json"] })))).toStrictEqual(
			PASSING_RESULT,
		);
	});

	it("should render the agent formatter with resolved hint paths", () => {
		expect.assertions(2);

		const output = format(
			makeConfig({
				formatters: [["agent", {}]],
				gameOutput: "game.log",
				outputFile: "jest.json",
			}),
			FAILING_RESULT,
		);

		expect(output).not.toContain(" RUN ");
		expect(output).toContain("game.log");
	});

	it("should use the default formatter when the agent formatter runs verbose", () => {
		expect.assertions(1);

		expect(format(makeConfig({ formatters: ["agent"], verbose: true }))).toContain(
			"Test Files",
		);
	});

	it("should render the default formatter otherwise", () => {
		expect.assertions(1);

		expect(format(makeConfig())).toContain("✓ src/utils.spec.ts (1 test");
	});
});
