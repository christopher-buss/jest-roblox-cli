import { type } from "arktype";
import { describe, expect, it } from "vitest";

import { perTestCoverageSchema } from "./coverage.ts";

describe("perTestCoverageSchema", () => {
	it("should accept the records the runner reports", () => {
		expect.assertions(1);

		const records = [
			{ delta: { "a.luau": { s: [1] } }, testCaseId: "t", testFilePath: "a.spec" },
		];

		expect(perTestCoverageSchema(records)).toStrictEqual(records);
	});

	it("should reject a delta without statement ids", () => {
		expect.assertions(1);

		expect(
			perTestCoverageSchema([
				{ delta: { "a.luau": {} }, testCaseId: "t", testFilePath: "a" },
			]),
		).toBeInstanceOf(type.errors);
	});
});
