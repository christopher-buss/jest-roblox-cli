import { fromAny } from "@total-typescript/shoehorn";

import { assert, describe, expect, it, vi } from "vitest";

import type { BackendTiming } from "../backends/interface.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import { DEFAULT_CONFIG } from "../config/schema.ts";
import { LuauScriptError } from "../reporter/parser.ts";
import { EXEC_ERROR_FILE_PATH } from "../types/jest-result.ts";
import type { ExecErrorEntry } from "./exec-error.ts";
import { buildExecutionErrorResult } from "./exec-error.ts";

const BACKEND_TIMING: BackendTiming = {
	executionMs: 23,
	uploadMs: 11,
};

const ENTRY: ExecErrorEntry = { pkg: "@scope/pkg", project: "unit", testFileCount: 3 };

function buildResult({
	bannerOutput,
	captureInstalled,
	deferFormatting,
	entry = ENTRY,
	gameOutput = "complete game log",
	message = "failure",
	phase,
	timedOut,
}: {
	bannerOutput?: string | undefined;
	captureInstalled?: boolean | undefined;
	deferFormatting: boolean | undefined;
	entry?: ExecErrorEntry | undefined;
	gameOutput?: string | undefined;
	message?: string | undefined;
	phase?: string | undefined;
	timedOut?: boolean | undefined;
}) {
	const error = new LuauScriptError(message);
	error.bannerOutput = bannerOutput;
	error.captureInstalled = captureInstalled;
	error.gameOutput = gameOutput;
	error.phase = phase;
	error.timedOut = timedOut;

	return buildExecutionErrorResult({
		backendTiming: BACKEND_TIMING,
		config: fromAny<ResolvedConfig, unknown>(DEFAULT_CONFIG),
		deferFormatting,
		entry,
		error,
		startTime: 1_000,
		version: "1.2.3",
	});
}

function failureMessageOf(options: Parameters<typeof buildResult>[0]): string {
	const message = buildResult(options).result.testResults[0]?.failureMessage;
	assert(message !== undefined, "an exec-error result always carries a failureMessage");
	return message;
}

function encodeOutput(...messages: Array<string>): string {
	return JSON.stringify(
		messages.map((message, index) => {
			return { message, messageType: 0, timestamp: index };
		}),
	);
}

describe(buildExecutionErrorResult, () => {
	it("should preserve the complete deferred failure contract", () => {
		expect.assertions(1);

		vi.spyOn(Date, "now").mockReturnValue(1_123);

		expect(buildResult({ deferFormatting: true })).toStrictEqual({
			exitCode: 1,
			gameOutput: "complete game log",
			output: "",
			result: {
				numFailedTests: 0,
				numPassedTests: 0,
				numPendingTests: 0,
				numTotalTests: 0,
				startTime: 1_000,
				success: false,
				testResults: [
					{
						failureMessage: "failure",
						numFailingTests: 0,
						numPassingTests: 0,
						numPendingTests: 0,
						testFilePath: EXEC_ERROR_FILE_PATH,
						testResults: [],
						timedOut: undefined,
					},
				],
			},
			timing: {
				executionMs: 23,
				startTime: 1_000,
				testsMs: 0,
				totalMs: 123,
				uploadMs: 11,
			},
		});
	});

	it("should mark an abandoned run timed out and still fail the run", () => {
		expect.assertions(2);

		const result = buildResult({ deferFormatting: true, timedOut: true });

		expect(result.result.testResults[0]).toHaveProperty("timedOut", true);
		expect(result.exitCode).toBe(1);
	});

	it("should format immediately unless formatting is explicitly deferred", () => {
		expect.assertions(2);

		vi.spyOn(Date, "now").mockReturnValue(1_123);

		expect(buildResult({ deferFormatting: false }).output).not.toBe("");
		expect(buildResult({ deferFormatting: undefined }).output).not.toBe("");
	});

	it("should prepend parsed banner output to an exact numeric exit message", () => {
		expect.assertions(1);

		const result = buildResult({
			bannerOutput: JSON.stringify([
				{ message: "actionable cause", messageType: 0, timestamp: 0 },
			]),
			deferFormatting: true,
			message: "Exited with code: 10",
		});

		expect(result.result.testResults[0]!.failureMessage).toBe(
			"actionable cause\n\nExited with code: 10",
		);
	});

	it("should preserve every parsed banner line in order", () => {
		expect.assertions(1);

		const result = buildResult({
			bannerOutput: JSON.stringify([
				{ message: "first cause", messageType: 0, timestamp: 0 },
				{ message: "second cause", messageType: 0, timestamp: 1 },
			]),
			deferFormatting: true,
			message: "Exited with code: 1",
		});

		expect(result.result.testResults[0]!.failureMessage).toBe(
			"first cause\nsecond cause\n\nExited with code: 1",
		);
	});

	it.for(["prefix Exited with code: 10", "Exited with code: 10 trailing"] as const)(
		"should preserve the non-exact exit message %j",
		(message) => {
			expect.assertions(1);

			const result = buildResult({
				bannerOutput: JSON.stringify([
					{ message: "actionable cause", messageType: 0, timestamp: 0 },
				]),
				deferFormatting: true,
				message,
			});

			expect(result.result.testResults[0]!.failureMessage).toBe(message);
		},
	);

	it.for([
		undefined,
		"",
		JSON.stringify([{ message: "  ", messageType: 0, timestamp: 0 }]),
	] as const)(
		"should report instead of guessing when banner output %j has no content",
		(bannerOutput) => {
			expect.assertions(2);

			const message = failureMessageOf({
				bannerOutput,
				deferFormatting: true,
				message: "Exited with code: 1",
			});

			expect(message).toStartWith(
				"Jest exited before returning a result, and no cause was captured.",
			);
			expect(message).toEndWith("Exited with code: 1");
		},
	);
});

// What the reader is left with when Jest exits without writing a cause
// anywhere the runner captured. The exit code alone names none of the several
// failures that exit this way, so the report says what the host knows for
// certain and stops there.
describe("an exit-code-only failure with nothing captured", () => {
	it("should report every fact the host holds about the entry", () => {
		expect.assertions(1);

		const message = failureMessageOf({
			captureInstalled: true,
			deferFormatting: true,
			gameOutput: encodeOutput("staging @scope/pkg", "No tests found in @scope/pkg"),
			message: "Exited with code: 1",
			phase: "run",
		});

		expect(message).toBe(
			[
				"Jest exited before returning a result, and no cause was captured.",
				"",
				"  Project      @scope/pkg › unit",
				"  Phase        running Jest",
				"  Test files   3 selected by the host",
				"  Capture      stdout/stderr intercepted; Jest wrote nothing",
				"  Game Output  2 lines captured; the last of them follow",
				"",
				"    staging @scope/pkg",
				"    No tests found in @scope/pkg",
				"",
				"Exited with code: 1",
			].join("\n"),
		);
	});

	it("should name the project alone outside workspace mode", () => {
		expect.assertions(1);

		const message = failureMessageOf({
			deferFormatting: true,
			entry: { project: "unit", testFileCount: 0 },
			message: "Exited with code: 1",
		});

		expect(message).toContain("  Project      unit\n");
	});

	it("should report a host selection of zero test files without calling it the cause", () => {
		expect.assertions(2);

		const message = failureMessageOf({
			deferFormatting: true,
			entry: { pkg: "@scope/pkg", project: "unit", testFileCount: 0 },
			message: "Exited with code: 1",
		});

		expect(message).toContain("  Test files   0 selected by the host\n");
		expect(message).not.toContain("No tests found");
	});

	it.for([
		["staging", "staging the package into the DataModel"],
		["resolveJest", "resolving the Jest module"],
		["resolveProjects", "resolving project and setup-file instances"],
		["run", "running Jest"],
	] as const)("should render the %j phase in words", ([phase, label]) => {
		expect.assertions(1);

		const message = failureMessageOf({
			deferFormatting: true,
			message: "Exited with code: 1",
			phase,
		});

		expect(message).toContain(`  Phase        ${label}\n`);
	});

	it("should render a phase this version has no wording for as itself", () => {
		expect.assertions(1);

		const message = failureMessageOf({
			deferFormatting: true,
			message: "Exited with code: 1",
			phase: "somethingNewer",
		});

		expect(message).toContain("  Phase        somethingNewer\n");
	});

	it.for([
		[undefined, "the runner does not report whether stdout/stderr was intercepted"],
		[true, "stdout/stderr intercepted; Jest wrote nothing"],
		[false, "stdout/stderr interception could not be installed"],
	] as const)("should tell a capture of %j apart from the others", ([captureInstalled, note]) => {
		expect.assertions(1);

		const message = failureMessageOf({
			captureInstalled,
			deferFormatting: true,
			message: "Exited with code: 1",
		});

		expect(message).toContain(`  Capture      ${note}\n`);
	});

	it("should keep the Game Output tail to its last lines", () => {
		expect.assertions(3);

		const message = failureMessageOf({
			deferFormatting: true,
			gameOutput: encodeOutput("one", "two", "three", "four", "five", "six", "seven"),
			message: "Exited with code: 1",
		});

		expect(message).toContain("  Game Output  7 lines captured; the last of them follow\n");
		expect(message).not.toContain("    two\n");
		expect(message).toContain("    three\n    four\n    five\n    six\n    seven\n");
	});

	it("should drop blank Game Output lines from the tail", () => {
		expect.assertions(2);

		const message = failureMessageOf({
			deferFormatting: true,
			gameOutput: encodeOutput(" ".repeat(3), "the last thing said"),
			message: "Exited with code: 1",
		});

		expect(message).toContain("    the last thing said\n");
		expect(message).not.toContain("       \n");
	});

	it("should say so when the Game Output holds nothing to show", () => {
		expect.assertions(2);

		const message = failureMessageOf({
			deferFormatting: true,
			gameOutput: encodeOutput("  "),
			message: "Exited with code: 1",
		});

		expect(message).toContain("  Game Output  nothing captured");
		expect(message).toEndWith("nothing captured\n\nExited with code: 1");
	});

	it("should still report a failed file carrying no failed tests", () => {
		expect.assertions(3);

		const result = buildResult({ deferFormatting: true, message: "Exited with code: 1" });

		expect(result.result.success).toBeFalse();
		expect(result.result.numFailedTests).toBe(0);
		expect(result.result.testResults[0]!.testResults).toBeEmpty();
	});
});
