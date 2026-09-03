import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it, vi } from "vitest";

import type { BackendTiming } from "../backends/interface.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import { DEFAULT_CONFIG } from "../config/schema.ts";
import { LuauScriptError } from "../reporter/parser.ts";
import { EXEC_ERROR_FILE_PATH } from "../types/jest-result.ts";
import { buildExecutionErrorResult } from "./exec-error.ts";

const BACKEND_TIMING: BackendTiming = {
	executionMs: 23,
	uploadMs: 11,
};

function buildResult({
	bannerOutput,
	deferFormatting,
	message = "failure",
	timedOut,
}: {
	bannerOutput?: string | undefined;
	deferFormatting: boolean | undefined;
	message?: string | undefined;
	timedOut?: boolean | undefined;
}) {
	const error = new LuauScriptError(message);
	error.bannerOutput = bannerOutput;
	error.gameOutput = "complete game log";
	error.timedOut = timedOut;

	return buildExecutionErrorResult({
		backendTiming: BACKEND_TIMING,
		config: fromAny<ResolvedConfig, unknown>(DEFAULT_CONFIG),
		deferFormatting,
		error,
		startTime: 1_000,
		version: "1.2.3",
	});
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
		"should keep the exit message when banner output %j has no content",
		(bannerOutput) => {
			expect.assertions(1);

			const result = buildResult({
				bannerOutput,
				deferFormatting: true,
				message: "Exited with code: 1",
			});

			expect(result.result.testResults[0]!.failureMessage).toBe("Exited with code: 1");
		},
	);
});
