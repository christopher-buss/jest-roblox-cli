import type { JestResult, TestCaseResult } from "../../types/jest-result.ts";
import type { TimingResult } from "../../types/timing.ts";

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

export const PASSING_RESULT: JestResult = {
	numFailedTests: 0,
	numPassedTests: 3,
	numPendingTests: 0,
	numTotalTests: 3,
	startTime: 1700000000000,
	success: true,
	testResults: [
		{
			numFailingTests: 0,
			numPassingTests: 3,
			numPendingTests: 0,
			testFilePath: "src/utils.spec.ts",
			testResults: [
				createTestCase({ fullName: "Utils add works", title: "add works" }),
				createTestCase({ fullName: "Utils sub works", title: "sub works" }),
				createTestCase({ fullName: "Utils mul works", title: "mul works" }),
			],
		},
	],
};

export const FAILING_RESULT: JestResult = {
	numFailedTests: 2,
	numPassedTests: 1,
	numPendingTests: 0,
	numTotalTests: 3,
	startTime: 1700000000000,
	success: false,
	testResults: [
		{
			numFailingTests: 2,
			numPassingTests: 1,
			numPendingTests: 0,
			testFilePath: "src/player.spec.ts",
			testResults: [
				createTestCase({
					ancestorTitles: ["Player"],
					fullName: "Player should spawn",
					title: "should spawn",
				}),
				createTestCase({
					ancestorTitles: ["Player"],
					duration: 5,
					failureMessages: [
						"expect(received).toBe(expected)\n\nExpected: 100\nReceived: 0",
					],
					fullName: "Player should have health",
					status: "failed",
					title: "should have health",
				}),
				createTestCase({
					ancestorTitles: ["Player"],
					duration: 3,
					failureMessages: [
						"expect(received).toBe(expected)\n\nExpected: true\nReceived: false",
					],
					fullName: "Player should be alive",
					status: "failed",
					title: "should be alive",
				}),
			],
		},
	],
};

export const MIXED_RESULT: JestResult = {
	numFailedTests: 1,
	numPassedTests: 4,
	numPendingTests: 1,
	numTotalTests: 6,
	startTime: 1700000000000,
	success: false,
	testResults: [
		{
			numFailingTests: 0,
			numPassingTests: 2,
			numPendingTests: 0,
			testFilePath: "src/utils.spec.ts",
			testResults: [
				createTestCase({ fullName: "Utils add works", title: "add works" }),
				createTestCase({ fullName: "Utils sub works", title: "sub works" }),
			],
		},
		{
			numFailingTests: 1,
			numPassingTests: 2,
			numPendingTests: 1,
			testFilePath: "src/game.spec.ts",
			testResults: [
				createTestCase({
					ancestorTitles: ["Game"],
					fullName: "Game should start",
					title: "should start",
				}),
				createTestCase({
					ancestorTitles: ["Game"],
					fullName: "Game should pause",
					title: "should pause",
				}),
				createTestCase({
					ancestorTitles: ["Game"],
					duration: 8,
					failureMessages: [
						'expect(received).toBe(expected)\n\nExpected: "ended"\nReceived: "running"',
					],
					fullName: "Game should end",
					status: "failed",
					title: "should end",
				}),
				createTestCase({
					ancestorTitles: ["Game"],
					fullName: "Game should restart",
					status: "pending",
					title: "should restart",
				}),
			],
		},
	],
};

export const TIMING: TimingResult = {
	executionMs: 150,
	startTime: 1700000000000,
	testsMs: 100,
	totalMs: 250,
	uploadCached: false,
	uploadMs: 50,
};

export const TIMING_CACHED: TimingResult = {
	executionMs: 150,
	startTime: 1700000000000,
	testsMs: 100,
	totalMs: 250,
	uploadCached: true,
	uploadMs: 50,
};

export const TIMING_NO_UPLOAD: TimingResult = {
	executionMs: 150,
	startTime: 1700000000000,
	testsMs: 100,
	totalMs: 200,
};

export const TIMING_COVERAGE: TimingResult = {
	coverageMs: 3000,
	executionMs: 150,
	startTime: 1700000000000,
	testsMs: 100,
	totalMs: 3250,
	uploadCached: false,
	uploadMs: 50,
};

export const SNAPSHOT_FAILING_RESULT: JestResult = {
	numFailedTests: 1,
	numPassedTests: 1,
	numPendingTests: 0,
	numTotalTests: 2,
	startTime: 1700000000000,
	success: false,
	testResults: [
		{
			numFailingTests: 1,
			numPassingTests: 1,
			numPendingTests: 0,
			testFilePath: "src/traits.spec.ts",
			testResults: [
				createTestCase({
					ancestorTitles: ["trait data"],
					fullName: "trait data Apex matches snapshot",
					title: "Apex matches snapshot",
				}),
				createTestCase({
					ancestorTitles: ["trait data"],
					duration: 12,
					failureMessages: [
						[
							"expect(received).toMatchSnapshot()",
							"",
							"Snapshot name: `trait data > Apex matches snapshot 1`",
							"",
							"- Snapshot  - 2",
							"+ Received  + 2",
							"",
							"  Object {",
							'    "name": "Apex",',
							'-   "health": 100,',
							'-   "speed": 50,',
							'+   "health": 150,',
							'+   "speed": 75,',
							"  }",
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
};

const PENDING_CASE: Partial<TestCaseResult> = { duration: undefined, status: "pending" };

export const SKIPPED_RESULT: JestResult = {
	numFailedTests: 0,
	numPassedTests: 5,
	numPendingTests: 7,
	numTotalTests: 12,
	startTime: 1700000000000,
	success: true,
	testResults: [
		{
			numFailingTests: 0,
			numPassingTests: 5,
			numPendingTests: 0,
			testFilePath: "src/codes.spec.ts",
			testResults: [
				createTestCase({ fullName: "Codes compress", title: "compress" }),
				createTestCase({ fullName: "Codes decompress", title: "decompress" }),
				createTestCase({ fullName: "Codes validate", title: "validate" }),
				createTestCase({ fullName: "Codes encode", title: "encode" }),
				createTestCase({ fullName: "Codes decode", title: "decode" }),
			],
		},
		{
			numFailingTests: 0,
			numPassingTests: 0,
			numPendingTests: 4,
			testFilePath: "src/utils.spec.ts",
			testResults: [
				createTestCase({ ...PENDING_CASE, fullName: "Utils add", title: "add" }),
				createTestCase({ ...PENDING_CASE, fullName: "Utils sub", title: "sub" }),
				createTestCase({ ...PENDING_CASE, fullName: "Utils mul", title: "mul" }),
				createTestCase({ ...PENDING_CASE, fullName: "Utils div", title: "div" }),
			],
		},
		{
			numFailingTests: 0,
			numPassingTests: 0,
			numPendingTests: 3,
			testFilePath: "src/player.spec.ts",
			testResults: [
				createTestCase({ ...PENDING_CASE, fullName: "Player spawn", title: "spawn" }),
				createTestCase({ ...PENDING_CASE, fullName: "Player health", title: "health" }),
				createTestCase({ ...PENDING_CASE, fullName: "Player alive", title: "alive" }),
			],
		},
	],
};

export const EXEC_ERROR_RESULT: JestResult = {
	numFailedTests: 0,
	numPassedTests: 0,
	numPendingTests: 0,
	numTotalTests: 0,
	startTime: 1700000000000,
	success: false,
	testResults: [
		{
			failureMessage:
				"  \u25cf Test suite failed to run\n\n    ReplicatedStorage.rbxts_include.node_modules.@rbxts-js.JestRuntime:1183: ReplicatedStorage.rbxts_include.node_modules.@rbxts-js.JestRuntime:1951: Require-by-string is not enabled for use inside Jest at this time.\n\n      ReplicatedStorage.rbxts_include.node_modules.@rbxts-js.JestRuntime:1183 function requireModule\n      ReplicatedStorage.rbxts_include.node_modules.@rbxts-js.JestCircus:114\n",
			numFailingTests: 0,
			numPassingTests: 0,
			numPendingTests: 0,
			testFilePath: "shared/react/features/windows/__tests__/unit-menu-app.test",
			testResults: [],
		},
	],
};

export const MIXED_WITH_EXEC_ERROR_RESULT: JestResult = {
	numFailedTests: 0,
	numPassedTests: 3,
	numPendingTests: 0,
	numTotalTests: 3,
	startTime: 1700000000000,
	success: false,
	testResults: [
		{
			numFailingTests: 0,
			numPassingTests: 3,
			numPendingTests: 0,
			testFilePath: "src/utils.spec.ts",
			testResults: [
				createTestCase({ fullName: "Utils add works", title: "add works" }),
				createTestCase({ fullName: "Utils sub works", title: "sub works" }),
				createTestCase({ fullName: "Utils mul works", title: "mul works" }),
			],
		},
		{
			failureMessage:
				"  \u25cf Test suite failed to run\n\n    Require-by-string is not enabled for use inside Jest at this time.\n",
			numFailingTests: 0,
			numPassingTests: 0,
			numPendingTests: 0,
			testFilePath: "src/broken.spec.ts",
			testResults: [],
		},
	],
};

export const LOADSTRING_ERROR_RESULT: JestResult = {
	numFailedTests: 0,
	numPassedTests: 0,
	numPendingTests: 0,
	numTotalTests: 0,
	startTime: 1700000000000,
	success: false,
	testResults: [
		{
			failureMessage:
				"  \u25cf Test suite failed to run\n\n    loadstring() is not available\n",
			numFailingTests: 0,
			numPassingTests: 0,
			numPendingTests: 0,
			testFilePath: "ReplicatedStorage/Client/lib/test.spec",
			testResults: [],
		},
	],
};

export const TYPECHECK_PASSING_RESULT: JestResult = {
	numFailedTests: 0,
	numPassedTests: 2,
	numPendingTests: 0,
	numTotalTests: 2,
	startTime: 1700000000000,
	success: true,
	testResults: [
		{
			numFailingTests: 0,
			numPassingTests: 2,
			numPendingTests: 0,
			testFilePath: "src/types.test-d.ts",
			testResults: [
				createTestCase({
					ancestorTitles: ["passing types"],
					duration: undefined,
					fullName: "passing types > should accept number as number",
					title: "should accept number as number",
				}),
				createTestCase({
					ancestorTitles: ["passing types"],
					duration: undefined,
					fullName: "passing types > should accept string as string",
					title: "should accept string as string",
				}),
			],
		},
	],
};

export const TYPECHECK_FAILING_RESULT: JestResult = {
	numFailedTests: 1,
	numPassedTests: 1,
	numPendingTests: 0,
	numTotalTests: 2,
	startTime: 1700000000000,
	success: false,
	testResults: [
		{
			numFailingTests: 1,
			numPassingTests: 1,
			numPendingTests: 0,
			testFilePath: "src/types.test-d.ts",
			testResults: [
				createTestCase({
					ancestorTitles: ["type checks"],
					duration: undefined,
					failureMessages: [
						"TS2322: Type 'string' is not assignable to type 'number'.",
					],
					fullName: "type checks > should reject string as number",
					status: "failed",
					title: "should reject string as number",
				}),
				createTestCase({
					ancestorTitles: ["type checks"],
					duration: undefined,
					fullName: "type checks > should accept number",
					title: "should accept number",
				}),
			],
		},
	],
};

export const TYPECHECK_MIXED_RESULT: JestResult = {
	numFailedTests: 1,
	numPassedTests: 3,
	numPendingTests: 0,
	numTotalTests: 4,
	startTime: 1700000000000,
	success: false,
	testResults: [
		{
			numFailingTests: 0,
			numPassingTests: 2,
			numPendingTests: 0,
			testFilePath: "src/passing.test-d.ts",
			testResults: [
				createTestCase({
					ancestorTitles: ["passing types"],
					duration: undefined,
					fullName: "passing types > should accept number",
					title: "should accept number",
				}),
				createTestCase({
					ancestorTitles: ["passing types"],
					duration: undefined,
					fullName: "passing types > should accept string",
					title: "should accept string",
				}),
			],
		},
		{
			numFailingTests: 1,
			numPassingTests: 1,
			numPendingTests: 0,
			testFilePath: "src/failing.test-d.ts",
			testResults: [
				createTestCase({
					ancestorTitles: ["failing types"],
					duration: undefined,
					failureMessages: [
						"TS2322: Type 'string' is not assignable to type 'number'.",
					],
					fullName: "failing types > should reject string as number",
					status: "failed",
					title: "should reject string as number",
				}),
				createTestCase({
					ancestorTitles: ["failing types"],
					duration: undefined,
					fullName: "failing types > should pass this one",
					title: "should pass this one",
				}),
			],
		},
	],
};

/** Minimal result for JSON snapshot (keeps snapshot under 50 lines) */
export const MINIMAL_RESULT: JestResult = {
	numFailedTests: 1,
	numPassedTests: 1,
	numPendingTests: 0,
	numTotalTests: 2,
	startTime: 1700000000000,
	success: false,
	testResults: [
		{
			numFailingTests: 1,
			numPassingTests: 1,
			numPendingTests: 0,
			testFilePath: "src/test.spec.ts",
			testResults: [
				createTestCase({ fullName: "Test passes", title: "passes" }),
				createTestCase({
					failureMessages: ["Expected: 1\nReceived: 2"],
					fullName: "Test fails",
					status: "failed",
					title: "fails",
				}),
			],
		},
	],
};
