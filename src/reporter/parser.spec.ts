import { describe, expect, it } from "vitest";

import type { JestResult } from "../types/jest-result.ts";
import { extractJsonFromOutput, LuauScriptError, parseJestOutput } from "./parser.ts";

describe(extractJsonFromOutput, () => {
	it("should extract JSON from output with surrounding text", () => {
		expect.assertions(1);

		const output = `
Some log output here
{"success":true,"numTotalTests":1}
More logs after
`;
		const json = extractJsonFromOutput(output);

		expect(json).toBe('{"success":true,"numTotalTests":1}');
	});

	it("should extract multi-line JSON object", () => {
		expect.assertions(1);

		const output = `
{
  "success": true,
  "numTotalTests": 2
}
`;
		const json = extractJsonFromOutput(output);

		expect(JSON.parse(json!)).toStrictEqual({
			numTotalTests: 2,
			success: true,
		});
	});

	it("should return undefined when no JSON found", () => {
		expect.assertions(1);

		const output = "Just plain text output";
		const json = extractJsonFromOutput(output);

		expect(json).toBeUndefined();
	});

	it("should skip brace-balanced but invalid JSON", () => {
		expect.assertions(1);

		const output = "{foo}\nmore text";
		const json = extractJsonFromOutput(output);

		expect(json).toBeUndefined();
	});
});

describe(parseJestOutput, () => {
	it("should parse valid Jest result JSON", () => {
		expect.assertions(3);

		const output = JSON.stringify({
			numFailedTests: 0,
			numPassedTests: 3,
			numPendingTests: 0,
			numTotalTests: 3,
			startTime: 1000,
			success: true,
			testResults: [],
		});

		const { result } = parseJestOutput(output);

		expect(result.success).toBeTrue();
		expect(result.numTotalTests).toBe(3);
		expect(result.numPassedTests).toBe(3);
	});

	it("should parse Jest result with test file results", () => {
		expect.assertions(3);

		const jestResult: JestResult = {
			numFailedTests: 1,
			numPassedTests: 1,
			numPendingTests: 0,
			numTotalTests: 2,
			startTime: 1000,
			success: false,
			testResults: [
				{
					numFailingTests: 1,
					numPassingTests: 1,
					numPendingTests: 0,
					testFilePath: "src/player.spec.ts",
					testResults: [
						{
							ancestorTitles: ["Player"],
							duration: 10,
							failureMessages: [],
							fullName: "Player should spawn",
							status: "passed",
							title: "should spawn",
						},
						{
							ancestorTitles: ["Player"],
							duration: 5,
							failureMessages: ["Expected 100, received 0"],
							fullName: "Player should have health",
							status: "failed",
							title: "should have health",
						},
					],
				},
			],
		};

		const output = JSON.stringify(jestResult);
		const { result } = parseJestOutput(output);

		expect(result.testResults).toHaveLength(1);
		expect(result.testResults[0]!.testResults).toHaveLength(2);
		expect(result.testResults[0]!.testResults[1]!.failureMessages).toContain(
			"Expected 100, received 0",
		);
	});

	it("should unwrap Ok result and parse inner value", () => {
		expect.assertions(2);

		const output = JSON.stringify({
			success: true,
			value: {
				numFailedTests: 0,
				numPassedTests: 1,
				numPendingTests: 0,
				numTotalTests: 1,
				startTime: 1000,
				success: true,
				testResults: [],
			},
		});

		const { result } = parseJestOutput(output);

		expect(result.success).toBeTrue();
		expect(result.numTotalTests).toBe(1);
	});

	it("should extract _timing from Ok result wrapper", () => {
		expect.assertions(2);

		const output = JSON.stringify({
			_timing: {
				configDecode: 0.001,
				findJest: 0.05,
				requireJest: 8.234,
			},
			success: true,
			value: {
				numFailedTests: 0,
				numPassedTests: 1,
				numPendingTests: 0,
				numTotalTests: 1,
				startTime: 1000,
				success: true,
				testResults: [],
			},
		});

		const { luauTiming, result } = parseJestOutput(output);

		expect(result.success).toBeTrue();
		expect(luauTiming).toStrictEqual({
			configDecode: 0.001,
			findJest: 0.05,
			requireJest: 8.234,
		});
	});

	it("should return no timing when _timing absent", () => {
		expect.assertions(1);

		const output = JSON.stringify({
			success: true,
			value: {
				numFailedTests: 0,
				numPassedTests: 1,
				numPendingTests: 0,
				numTotalTests: 1,
				startTime: 1000,
				success: true,
				testResults: [],
			},
		});

		const { luauTiming } = parseJestOutput(output);

		expect(luauTiming).toBeUndefined();
	});

	it("should throw LuauScriptError on Fail result", () => {
		expect.assertions(1);

		const output = JSON.stringify({
			err: "Failed to find Jest instance in ReplicatedStorage",
			success: false,
		});

		expect(() => parseJestOutput(output)).toThrowWithMessage(
			LuauScriptError,
			"Failed to find Jest instance in ReplicatedStorage",
		);
	});

	it("should extract message from object errors in Fail result", () => {
		expect.assertions(1);

		const output = JSON.stringify({
			err: { code: 42, message: "something broke" },
			success: false,
		});

		expect(() => parseJestOutput(output)).toThrowWithMessage(
			LuauScriptError,
			"something broke",
		);
	});

	it("should stringify object errors without message field", () => {
		expect.assertions(1);

		const output = JSON.stringify({
			err: { code: 42, detail: "unknown" },
			success: false,
		});

		expect(() => parseJestOutput(output)).toThrowWithMessage(
			LuauScriptError,
			'{"code":42,"detail":"unknown"}',
		);
	});

	it("should extract root error from ExecutionError in Fail result", () => {
		expect.assertions(1);

		const output = JSON.stringify({
			err: {
				error: "This Promise was chained to a Promise that errored.",
				kind: "ExecutionError",
				parent: {
					error: "Exited with code: 1",
					kind: "ExecutionError",
				},
			},
			success: false,
		});

		expect(() => parseJestOutput(output)).toThrowWithMessage(
			LuauScriptError,
			"Exited with code: 1",
		);
	});

	it("should extract error from ExecutionError without parent in Fail result", () => {
		expect.assertions(1);

		const output = JSON.stringify({
			err: {
				error: "Something broke",
				kind: "ExecutionError",
			},
			success: false,
		});

		expect(() => parseJestOutput(output)).toThrowWithMessage(
			LuauScriptError,
			"Something broke",
		);
	});

	it("should strip TaskScript prefix from Fail result error", () => {
		expect.assertions(1);

		const output = JSON.stringify({
			err: "TaskScript:72: Failed to find Jest instance in ReplicatedStorage",
			success: false,
		});

		expect(() => parseJestOutput(output)).toThrowWithMessage(
			LuauScriptError,
			"Failed to find Jest instance in ReplicatedStorage",
		);
	});

	it("should throw on invalid JSON", () => {
		expect.assertions(1);

		expect(() => parseJestOutput("not json")).toThrow(/No valid Jest result JSON found/);
	});

	it("should extract JSON from mixed output and parse", () => {
		expect.assertions(1);

		const mixed = `
Roblox output log...
{"success":true,"numTotalTests":0,"numPassedTests":0,"numFailedTests":0,"numPendingTests":0,"startTime":0,"testResults":[]}
End of output
`;
		const { result } = parseJestOutput(mixed);

		expect(result.success).toBeTrue();
	});

	it("should extract _snapshotWrites from result", () => {
		expect.assertions(2);

		const output = JSON.stringify({
			_snapshotWrites: {
				"ReplicatedStorage/shared/__snapshots__/Button.spec.snap.luau":
					'-- Jest Snapshot v1\nexports["Button renders"] = "hello";\n',
			},
			success: true,
			value: {
				numFailedTests: 0,
				numPassedTests: 1,
				numPendingTests: 0,
				numTotalTests: 1,
				startTime: 1000,
				success: true,
				testResults: [],
			},
		});

		const { result, snapshotWrites } = parseJestOutput(output);

		expect(result.success).toBeTrue();
		expect(snapshotWrites).toStrictEqual({
			"ReplicatedStorage/shared/__snapshots__/Button.spec.snap.luau":
				'-- Jest Snapshot v1\nexports["Button renders"] = "hello";\n',
		});
	});

	it("should return no snapshotWrites when absent", () => {
		expect.assertions(1);

		const output = JSON.stringify({
			success: true,
			value: {
				numFailedTests: 0,
				numPassedTests: 1,
				numPendingTests: 0,
				numTotalTests: 1,
				startTime: 1000,
				success: true,
				testResults: [],
			},
		});

		const { snapshotWrites } = parseJestOutput(output);

		expect(snapshotWrites).toBeUndefined();
	});

	it("should extract _coverage from output", () => {
		expect.assertions(2);

		const output = JSON.stringify({
			_coverage: {
				"shared/player.luau": { s: { 0: 1, 1: 3, 2: 0 } },
			},
			success: true,
			value: {
				numFailedTests: 0,
				numPassedTests: 1,
				numPendingTests: 0,
				numTotalTests: 1,
				startTime: 1000,
				success: true,
				testResults: [],
			},
		});

		const { coverageData, result } = parseJestOutput(output);

		expect(result.success).toBeTrue();
		expect(coverageData).toStrictEqual({
			"shared/player.luau": { b: undefined, f: undefined, s: { 0: 1, 1: 3, 2: 0 } },
		});
	});

	it("should return undefined coverageData when absent", () => {
		expect.assertions(1);

		const output = JSON.stringify({
			success: true,
			value: {
				numFailedTests: 0,
				numPassedTests: 1,
				numPendingTests: 0,
				numTotalTests: 1,
				startTime: 1000,
				success: true,
				testResults: [],
			},
		});

		const { coverageData } = parseJestOutput(output);

		expect(coverageData).toBeUndefined();
	});

	it("should handle empty _coverage", () => {
		expect.assertions(1);

		const output = JSON.stringify({
			_coverage: {},
			success: true,
			value: {
				numFailedTests: 0,
				numPassedTests: 1,
				numPendingTests: 0,
				numTotalTests: 1,
				startTime: 1000,
				success: true,
				testResults: [],
			},
		});

		const { coverageData } = parseJestOutput(output);

		expect(coverageData).toBeUndefined();
	});

	it("should normalize array-format coverage hit counts from Luau", () => {
		expect.assertions(1);

		const output = JSON.stringify({
			_coverage: {
				"file.luau": { s: [1, 0, 3] },
			},
			success: true,
			value: {
				numFailedTests: 0,
				numPassedTests: 1,
				numPendingTests: 0,
				numTotalTests: 1,
				startTime: 1000,
				success: true,
				testResults: [],
			},
		});

		const { coverageData } = parseJestOutput(output);

		expect(coverageData!["file.luau"]!.s).toStrictEqual({ "1": 1, "2": 0, "3": 3 });
	});

	it("should normalize array-of-arrays branch counts from Luau", () => {
		expect.assertions(1);

		const output = JSON.stringify({
			_coverage: {
				"file.luau": {
					b: [
						[1, 0],
						[3, 2, 1],
					],
					s: { "1": 1 },
				},
			},
			success: true,
			value: {
				numFailedTests: 0,
				numPassedTests: 1,
				numPendingTests: 0,
				numTotalTests: 1,
				startTime: 1000,
				success: true,
				testResults: [],
			},
		});

		const { coverageData } = parseJestOutput(output);

		expect(coverageData!["file.luau"]!.b).toStrictEqual({
			"1": [1, 0],
			"2": [3, 2, 1],
		});
	});

	it("should handle non-array inner branch counts gracefully", () => {
		expect.assertions(1);

		const output = JSON.stringify({
			_coverage: {
				"file.luau": { b: ["not-array", null], s: { "1": 1 } },
			},
			success: true,
			value: {
				numFailedTests: 0,
				numPassedTests: 1,
				numPendingTests: 0,
				numTotalTests: 1,
				startTime: 1000,
				success: true,
				testResults: [],
			},
		});

		const { coverageData } = parseJestOutput(output);

		expect(coverageData!["file.luau"]!.b).toStrictEqual({
			"1": [],
			"2": [],
		});
	});

	it("should normalize array-format function hit counts", () => {
		expect.assertions(1);

		const output = JSON.stringify({
			_coverage: {
				"file.luau": { f: [5, 0, 2], s: { "1": 1 } },
			},
			success: true,
			value: {
				numFailedTests: 0,
				numPassedTests: 1,
				numPendingTests: 0,
				numTotalTests: 1,
				startTime: 1000,
				success: true,
				testResults: [],
			},
		});

		const { coverageData } = parseJestOutput(output);

		expect(coverageData!["file.luau"]!.f).toStrictEqual({ "1": 5, "2": 0, "3": 2 });
	});

	it("should filter non-number values from _timing", () => {
		expect.assertions(1);

		const output = JSON.stringify({
			_timing: {
				configDecode: 0.1,
				invalid: "not a number",
			},
			success: true,
			value: {
				numFailedTests: 0,
				numPassedTests: 1,
				numPendingTests: 0,
				numTotalTests: 1,
				startTime: 1000,
				success: true,
				testResults: [],
			},
		});

		const { luauTiming } = parseJestOutput(output);

		expect(luauTiming).toStrictEqual({ configDecode: 0.1 });
	});

	it("should return undefined timing when all values are non-number", () => {
		expect.assertions(1);

		const output = JSON.stringify({
			_timing: { bad: "string" },
			success: true,
			value: {
				numFailedTests: 0,
				numPassedTests: 1,
				numPendingTests: 0,
				numTotalTests: 1,
				startTime: 1000,
				success: true,
				testResults: [],
			},
		});

		const { luauTiming } = parseJestOutput(output);

		expect(luauTiming).toBeUndefined();
	});

	it("should extract _setup seconds from envelope", () => {
		expect.assertions(1);

		const output = JSON.stringify({
			_setup: 0.25,
			success: true,
			value: {
				numFailedTests: 0,
				numPassedTests: 1,
				numPendingTests: 0,
				numTotalTests: 1,
				startTime: 1000,
				success: true,
				testResults: [],
			},
		});

		const { setupSeconds } = parseJestOutput(output);

		expect(setupSeconds).toBe(0.25);
	});

	it("should return undefined setupSeconds when _setup absent", () => {
		expect.assertions(1);

		const output = JSON.stringify({
			success: true,
			value: {
				numFailedTests: 0,
				numPassedTests: 1,
				numPendingTests: 0,
				numTotalTests: 1,
				startTime: 1000,
				success: true,
				testResults: [],
			},
		});

		const { setupSeconds } = parseJestOutput(output);

		expect(setupSeconds).toBeUndefined();
	});

	it("should return undefined setupSeconds when _setup is not a number", () => {
		expect.assertions(1);

		const output = JSON.stringify({
			_setup: "bad",
			success: true,
			value: {
				numFailedTests: 0,
				numPassedTests: 1,
				numPendingTests: 0,
				numTotalTests: 1,
				startTime: 1000,
				success: true,
				testResults: [],
			},
		});

		const { setupSeconds } = parseJestOutput(output);

		expect(setupSeconds).toBeUndefined();
	});

	it("should filter non-string values from _snapshotWrites", () => {
		expect.assertions(1);

		const output = JSON.stringify({
			_snapshotWrites: {
				"file.snap": "content",
				"invalid": 123,
			},
			success: true,
			value: {
				numFailedTests: 0,
				numPassedTests: 1,
				numPendingTests: 0,
				numTotalTests: 1,
				startTime: 1000,
				success: true,
				testResults: [],
			},
		});

		const { snapshotWrites } = parseJestOutput(output);

		expect(snapshotWrites).toStrictEqual({ "file.snap": "content" });
	});

	it("should throw on ExecutionError kind", () => {
		expect.assertions(1);

		const output = JSON.stringify({
			success: true,
			value: {
				error: "Promise rejected",
				kind: "ExecutionError",
			},
		});

		expect(() => parseJestOutput(output)).toThrowWithMessage(
			Error,
			"Jest execution failed: Promise rejected",
		);
	});

	it("should traverse parent chain in ExecutionError", () => {
		expect.assertions(1);

		const output = JSON.stringify({
			success: true,
			value: {
				kind: "ExecutionError",
				parent: {
					error: "Root cause error",
				},
			},
		});

		expect(() => parseJestOutput(output)).toThrowWithMessage(
			Error,
			"Jest execution failed: Root cause error",
		);
	});

	it("should handle ExecutionError with missing error field", () => {
		expect.assertions(1);

		const output = JSON.stringify({
			success: true,
			value: {
				kind: "ExecutionError",
			},
		});

		expect(() => parseJestOutput(output)).toThrowWithMessage(
			Error,
			"Jest execution failed: Unknown error",
		);
	});

	it("should throw on invalid Jest result schema", () => {
		expect.assertions(1);

		const output = JSON.stringify({
			success: true,
			value: { results: { invalid: true } },
		});

		expect(() => parseJestOutput(output)).toThrow(/Invalid Jest result/);
	});

	it("should unwrap results field from globalConfig wrapper", () => {
		expect.assertions(1);

		const output = JSON.stringify({
			success: true,
			value: {
				globalConfig: {},
				results: {
					numFailedTests: 0,
					numPassedTests: 1,
					numPendingTests: 0,
					numTotalTests: 1,
					startTime: 1000,
					success: true,
					testResults: [],
				},
			},
		});

		const { result } = parseJestOutput(output);

		expect(result.numTotalTests).toBe(1);
	});

	it("should return empty record when s is non-array non-object", () => {
		expect.assertions(1);

		const output = JSON.stringify({
			_coverage: {
				"file.luau": { s: "string" },
			},
			success: true,
			value: {
				numFailedTests: 0,
				numPassedTests: 1,
				numPendingTests: 0,
				numTotalTests: 1,
				startTime: 1000,
				success: true,
				testResults: [],
			},
		});

		const { coverageData } = parseJestOutput(output);

		expect(coverageData!["file.luau"]!.s).toBeEmptyObject();
	});

	it("should return empty record when b is non-array non-object", () => {
		expect.assertions(1);

		const output = JSON.stringify({
			_coverage: {
				"file.luau": { b: 42, s: { "1": 1 } },
			},
			success: true,
			value: {
				numFailedTests: 0,
				numPassedTests: 1,
				numPendingTests: 0,
				numTotalTests: 1,
				startTime: 1000,
				success: true,
				testResults: [],
			},
		});

		const { coverageData } = parseJestOutput(output);

		expect(coverageData!["file.luau"]!.b).toBeEmptyObject();
	});

	it("should pass through object-format branch counts", () => {
		expect.assertions(1);

		const output = JSON.stringify({
			_coverage: {
				"file.luau": {
					b: { "1": [1, 0], "2": [3, 2] },
					s: { "1": 1 },
				},
			},
			success: true,
			value: {
				numFailedTests: 0,
				numPassedTests: 1,
				numPendingTests: 0,
				numTotalTests: 1,
				startTime: 1000,
				success: true,
				testResults: [],
			},
		});

		const { coverageData } = parseJestOutput(output);

		expect(coverageData!["file.luau"]!.b).toStrictEqual({
			"1": [1, 0],
			"2": [3, 2],
		});
	});

	it("should coerce non-number elements to 0 in array-format statement counts", () => {
		expect.assertions(1);

		const output = JSON.stringify({
			_coverage: {
				"file.luau": { s: ["not-a-number", 5] },
			},
			success: true,
			value: {
				numFailedTests: 0,
				numPassedTests: 1,
				numPendingTests: 0,
				numTotalTests: 1,
				startTime: 1000,
				success: true,
				testResults: [],
			},
		});

		const { coverageData } = parseJestOutput(output);

		expect(coverageData!["file.luau"]!.s).toStrictEqual({ "1": 0, "2": 5 });
	});

	it("should coerce non-number values to 0 inside branch inner arrays", () => {
		expect.assertions(1);

		const output = JSON.stringify({
			_coverage: {
				"file.luau": { b: [["not-a-number", 1]], s: { "1": 1 } },
			},
			success: true,
			value: {
				numFailedTests: 0,
				numPassedTests: 1,
				numPendingTests: 0,
				numTotalTests: 1,
				startTime: 1000,
				success: true,
				testResults: [],
			},
		});

		const { coverageData } = parseJestOutput(output);

		expect(coverageData!["file.luau"]!.b).toStrictEqual({ "1": [0, 1] });
	});

	it("should return undefined snapshotWrites when all values are non-strings", () => {
		expect.assertions(1);

		const output = JSON.stringify({
			_snapshotWrites: { key: 123 },
			success: true,
			value: {
				numFailedTests: 0,
				numPassedTests: 1,
				numPendingTests: 0,
				numTotalTests: 1,
				startTime: 1000,
				success: true,
				testResults: [],
			},
		});

		const { snapshotWrites } = parseJestOutput(output);

		expect(snapshotWrites).toBeUndefined();
	});

	it("should stringify null error via JSON.stringify", () => {
		expect.assertions(1);

		// null is not a string and not an object with .message, so stringifyError
		// falls through to JSON.stringify(null) which returns "null"
		const rawOutput = '{"err":null,"success":false}';

		expect(() => parseJestOutput(rawOutput)).toThrowWithMessage(Error, "null");
	});

	it("should stringify numeric error via JSON.stringify", () => {
		expect.assertions(1);

		const output = JSON.stringify({
			err: 42,
			success: false,
		});

		expect(() => parseJestOutput(output)).toThrowWithMessage(Error, "42");
	});

	it("should skip _coverage entries without s field", () => {
		expect.assertions(1);

		const output = JSON.stringify({
			_coverage: {
				"bad.luau": { noS: true },
				"good.luau": { s: { "1": 1 } },
			},
			success: true,
			value: {
				numFailedTests: 0,
				numPassedTests: 1,
				numPendingTests: 0,
				numTotalTests: 1,
				startTime: 1000,
				success: true,
				testResults: [],
			},
		});

		const { coverageData } = parseJestOutput(output);

		expect(coverageData).toStrictEqual({
			"good.luau": { b: undefined, f: undefined, s: { "1": 1 } },
		});
	});
});
