import { type } from "arktype";
import { describe, it } from "vitest";

import { jestResultSchema } from "./jest-result-schema.ts";

function makeResult(testResults: Array<unknown>): Record<string, unknown> {
	return {
		numFailedTests: 0,
		numPassedTests: 1,
		numPendingTests: 0,
		numTotalTests: 1,
		snapshot: { unmatched: "left for the parser" },
		startTime: 0,
		success: true,
		testResults,
	};
}

describe("jestResultSchema", () => {
	it("should accept a result with its file and test results", ({ expect }) => {
		expect.assertions(1);

		const result = makeResult([
			{
				numFailingTests: 0,
				numPassingTests: 1,
				numPendingTests: 0,
				testFilePath: "src/a.spec.ts",
				testResults: [
					{
						ancestorTitles: ["A"],
						failureMessages: [],
						fullName: "A should pass",
						location: { column: 2, line: 3 },
						status: "passed",
						title: "should pass",
					},
				],
			},
		]);

		const parsed: unknown = jestResultSchema(result);

		expect(parsed).toStrictEqual(result);
	});

	it("should reject a file result without its counts", ({ expect }) => {
		expect.assertions(1);

		const result = makeResult([{ testFilePath: "src/a.spec.ts", testResults: [] }]);

		expect(jestResultSchema(result)).toBeInstanceOf(type.errors);
	});

	it("should reject a test result with an unknown status", ({ expect }) => {
		expect.assertions(1);

		const result = makeResult([
			{
				numFailingTests: 0,
				numPassingTests: 0,
				numPendingTests: 0,
				testFilePath: "src/a.spec.ts",
				testResults: [
					{
						ancestorTitles: [],
						failureMessages: [],
						fullName: "a",
						status: "flaky",
						title: "a",
					},
				],
			},
		]);

		expect(jestResultSchema(result)).toBeInstanceOf(type.errors);
	});
});
