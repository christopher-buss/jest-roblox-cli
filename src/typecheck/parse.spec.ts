import { describe, expect, it } from "vitest";

import { parseTscOutput } from "./parse.ts";
import type { TscErrorInfo } from "./types.ts";

describe(parseTscOutput, () => {
	it("should parse a single error line", () => {
		expect.assertions(3);

		const output =
			"src/index.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.";
		const result = parseTscOutput(output);

		expect(result.size).toBe(1);

		const errors = result.get("src/index.ts");

		expect(errors).toHaveLength(1);
		expect(errors![0]).toStrictEqual({
			column: 5,
			errorCode: 2322,
			errorMessage: "Type 'string' is not assignable to type 'number'.",
			filePath: "src/index.ts",
			line: 10,
		} satisfies TscErrorInfo);
	});

	it("should group multiple errors for the same file", () => {
		expect.assertions(2);

		const output = [
			"src/index.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.",
			"src/index.ts(20,1): error TS2345: Argument of type 'boolean' is not assignable.",
		].join("\n");
		const result = parseTscOutput(output);

		expect(result.size).toBe(1);
		expect(result.get("src/index.ts")).toHaveLength(2);
	});

	it("should separate errors across multiple files", () => {
		expect.assertions(3);

		const output = [
			"src/a.ts(1,1): error TS2322: Error in a.",
			"src/b.ts(2,2): error TS2322: Error in b.",
		].join("\n");
		const result = parseTscOutput(output);

		expect(result.size).toBe(2);
		expect(result.get("src/a.ts")).toHaveLength(1);
		expect(result.get("src/b.ts")).toHaveLength(1);
	});

	it("should merge indented continuation lines with parent", () => {
		expect.assertions(2);

		const output = [
			"src/index.ts(5,3): error TS2322: This expression is not callable.",
			"  Type 'ExpectString<number>' has no call signatures.",
		].join("\n");
		const result = parseTscOutput(output);

		const errors = result.get("src/index.ts");

		expect(errors).toHaveLength(1);
		expect(errors![0]!.errorMessage).toContain("has no call signatures");
	});

	it("should return empty map for empty output", () => {
		expect.assertions(1);
		expect(parseTscOutput("").size).toBe(0);
	});

	it("should skip malformed lines", () => {
		expect.assertions(2);

		const output = [
			"some random text",
			"src/index.ts(10,5): error TS2322: Real error.",
			"another garbage line",
		].join("\n");
		const result = parseTscOutput(output);

		expect(result.size).toBe(1);
		expect(result.get("src/index.ts")).toHaveLength(1);
	});

	it("should handle Windows absolute paths", () => {
		expect.assertions(3);

		const output = "D:\\projects\\src\\index.ts(10,5): error TS2322: Type mismatch.";
		const result = parseTscOutput(output);

		expect(result.size).toBe(1);

		const errors = result.get("D:\\projects\\src\\index.ts");

		expect(errors).toHaveLength(1);
		expect(errors![0]!.line).toBe(10);
	});

	it("should skip line with open paren but no close paren", () => {
		expect.assertions(1);

		const output = "src/index.ts(10,5: error TS2322: Missing close paren.";
		const result = parseTscOutput(output);

		expect(result.size).toBe(0);
	});

	it("should skip line with position missing comma", () => {
		expect.assertions(1);

		const output = "src/index.ts(10): error TS2322: No column.";
		const result = parseTscOutput(output);

		expect(result.size).toBe(0);
	});

	it("should ignore leading continuation line with no parent", () => {
		expect.assertions(1);

		const output = "  orphaned continuation line\nsrc/a.ts(1,1): error TS2322: Real.";
		const result = parseTscOutput(output);

		expect(result.size).toBe(1);
	});

	it("should skip line with valid position but no error code", () => {
		expect.assertions(1);

		const output = "src/index.ts(10,5): some other message without TS code.";
		const result = parseTscOutput(output);

		expect(result.size).toBe(0);
	});

	it("should skip line with valid position but malformed TS error code", () => {
		expect.assertions(1);

		const output = "src/index.ts(10,5): error TS: no digits after TS.";
		const result = parseTscOutput(output);

		expect(result.size).toBe(0);
	});
});
