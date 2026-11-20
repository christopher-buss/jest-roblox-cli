import { type, type Type } from "arktype";
import type { Except } from "type-fest";

import type { JestResult, TestCaseResult, TestFileResult } from "../types/jest-result-types.ts";

const OPTIONAL_NUMBER = "number | undefined";

/** A Jest result whose snapshot summary is not parsed yet. */
export type UnparsedJestResult = Except<JestResult, "snapshot"> & { snapshot?: unknown };

const gapsSchema = type({ "[string]": "number" });

const testCaseResultSchema = type.declare<TestCaseResult>().type({
	"ancestorTitles": "string[]",
	"duration?": OPTIONAL_NUMBER,
	"failureMessages": "string[]",
	"fullName": "string",
	"gaps?": gapsSchema.or("undefined"),
	"location?": { column: "number", line: "number" },
	"numPassingAsserts?": OPTIONAL_NUMBER,
	"retryReasons?": "string[] | undefined",
	"status": "'disabled' | 'failed' | 'passed' | 'pending' | 'skipped' | 'todo'",
	"title": "string",
});

const testFileResultSchema = type.declare<TestFileResult>().type({
	"failureMessage?": "string | undefined",
	"gaps?": gapsSchema.or("undefined"),
	"numFailingTests": "number",
	"numPassingTests": "number",
	"numPendingTests": "number",
	"testFilePath": "string",
	"testResults": testCaseResultSchema.array(),
	"timedOut?": "boolean | undefined",
});

export const jestResultSchema: Type<UnparsedJestResult> = type.declare<UnparsedJestResult>().type({
	"numFailedTests": "number",
	"numPassedTests": "number",
	"numPendingTests": "number",
	"numTodoTests?": OPTIONAL_NUMBER,
	"numTotalTests": "number",
	"snapshot?": "unknown",
	"startTime": "number",
	"success": "boolean",
	"testResults": testFileResultSchema.array(),
});
