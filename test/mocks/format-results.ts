import type { JestResult, TestCaseResult, TestFileResult } from "#src/types/jest-result-types.ts";

const UTILS_SPEC = "src/utils.spec.ts";
const UTILS_ADD = "Utils add works";
const UTILS_SUB = "Utils sub works";
const UTILS_MUL = "Utils mul works";

export function createTestCase(overrides: Partial<TestCaseResult> = {}): TestCaseResult {
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

export function utilsFileResult(): TestFileResult {
	return {
		numFailingTests: 0,
		numPassingTests: 3,
		numPendingTests: 0,
		testFilePath: UTILS_SPEC,
		testResults: [
			createTestCase({ fullName: UTILS_ADD, title: "add works" }),
			createTestCase({ fullName: UTILS_SUB, title: "sub works" }),
			createTestCase({ fullName: UTILS_MUL, title: "mul works" }),
		],
	};
}

export function oneFailedOfTwo(
	testFilePath: string,
	testResults: Array<TestCaseResult>,
): JestResult {
	return {
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
				testFilePath,
				testResults,
			},
		],
	};
}

export const PASSING_RESULT: JestResult = {
	numFailedTests: 0,
	numPassedTests: 3,
	numPendingTests: 0,
	numTotalTests: 3,
	startTime: 1700000000000,
	success: true,
	testResults: [utilsFileResult()],
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
			testFilePath: UTILS_SPEC,
			testResults: [
				createTestCase({ fullName: UTILS_ADD, title: "add works" }),
				createTestCase({ fullName: UTILS_SUB, title: "sub works" }),
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
					duration: undefined,
					fullName: "Game should restart",
					status: "pending",
					title: "should restart",
				}),
			],
		},
	],
};

export const SNAPSHOT_FAILING_RESULT = oneFailedOfTwo("src/traits.spec.ts", [
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
]);

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
			testFilePath: UTILS_SPEC,
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

export const MINIMAL_RESULT = oneFailedOfTwo("src/test.spec.ts", [
	createTestCase({ fullName: "Test passes", title: "passes" }),
	createTestCase({
		failureMessages: ["Expected: 1\nReceived: 2"],
		fullName: "Test fails",
		status: "failed",
		title: "fails",
	}),
]);

export const EMPTY_FILE_RESULT: JestResult = {
	numFailedTests: 0,
	numPassedTests: 3,
	numPendingTests: 0,
	numTotalTests: 3,
	startTime: 1700000000000,
	success: true,
	testResults: [
		utilsFileResult(),
		{
			numFailingTests: 0,
			numPassingTests: 0,
			numPendingTests: 0,
			testFilePath: "src/empty.spec.ts",
			testResults: [],
		},
	],
};
