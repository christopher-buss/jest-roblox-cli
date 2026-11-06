import type { JestResult } from "#src/types/jest-result-types.ts";
import { createTestCase, oneFailedOfTwo } from "#test/mocks/format-results.ts";

const PASSING_TYPES = "passing types";

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
					ancestorTitles: [PASSING_TYPES],
					duration: undefined,
					fullName: "passing types > should accept number as number",
					title: "should accept number as number",
				}),
				createTestCase({
					ancestorTitles: [PASSING_TYPES],
					duration: undefined,
					fullName: "passing types > should accept string as string",
					title: "should accept string as string",
				}),
			],
		},
	],
};

export const TYPECHECK_FAILING_RESULT = oneFailedOfTwo("src/types.test-d.ts", [
	createTestCase({
		ancestorTitles: ["type checks"],
		duration: undefined,
		failureMessages: ["TS2322: Type 'string' is not assignable to type 'number'."],
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
]);

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
					ancestorTitles: [PASSING_TYPES],
					duration: undefined,
					fullName: "passing types > should accept number",
					title: "should accept number",
				}),
				createTestCase({
					ancestorTitles: [PASSING_TYPES],
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
					failureMessages: ["TS2322: Type 'string' is not assignable to type 'number'."],
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
