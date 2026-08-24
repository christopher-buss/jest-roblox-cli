import type { AstStatBlock } from "@isentinel/luau-ast/ast";

import { assert, describe, expect, it } from "vitest";

import { evalLuauReturnLiterals } from "./eval-literals.ts";
import { luauParser } from "./parser.ts";

function parseBlock(source: string): AstStatBlock {
	const parsed = luauParser.parse(source);
	assert(parsed.ok);
	return parsed.root;
}

function evalSource(source: string) {
	return evalLuauReturnLiterals(parseBlock(source));
}

describe(evalLuauReturnLiterals, () => {
	it("should return string literal", () => {
		expect.assertions(1);

		expect(evalSource('return "hello"')).toBe("hello");
	});

	it("should return boolean literal", () => {
		expect.assertions(1);

		expect(evalSource("return true")).toBeTrue();
	});

	it("should return number literal", () => {
		expect.assertions(1);

		expect(evalSource("return 42")).toBe(42);
	});

	it("should return nil as undefined", () => {
		expect.assertions(1);

		expect(evalSource("return nil")).toBeUndefined();
	});

	it("should evaluate record table to object", () => {
		expect.assertions(1);

		expect(evalSource('return {\n\ttimeout = 5,\n\tname = "suite",\n}')).toStrictEqual({
			name: "suite",
			timeout: 5,
		});
	});

	it("should evaluate list table to array", () => {
		expect.assertions(1);

		expect(evalSource('return { "a", "b", 3 }')).toStrictEqual(["a", "b", 3]);
	});

	it("should evaluate empty table to empty object", () => {
		expect.assertions(1);

		expect(evalSource("return {}")).toStrictEqual({});
	});

	it("should unwrap cast expressions", () => {
		expect.assertions(1);

		expect(evalSource("return 5 :: number")).toBe(5);
	});

	it("should unwrap nested cast expressions", () => {
		expect.assertions(1);

		expect(evalSource("return (5 :: any) :: number")).toBeUndefined();
	});

	it("should skip record entries with a computed key", () => {
		expect.assertions(1);

		expect(evalSource('return {\n\t[key] = 1,\n\tname = "kept",\n}')).toStrictEqual({
			name: "kept",
		});
	});

	it("should throw when no return statement exists", () => {
		expect.assertions(1);

		expect(() => evalSource("local x = 1")).toThrow("Config file has no return statement");
	});

	it("should throw when return has no expressions", () => {
		expect.assertions(1);

		expect(() => evalSource("return")).toThrow("Return statement has no expressions");
	});

	it("should return undefined for unsupported expression types", () => {
		expect.assertions(1);

		expect(evalSource("return someFunction()")).toBeUndefined();
	});

	it("should return undefined for unsupported entries in a list table", () => {
		expect.assertions(1);

		expect(evalSource("return { someFunction(), 2 }")).toStrictEqual([undefined, 2]);
	});

	it("should evaluate nested tables", () => {
		expect.assertions(1);

		const source = [
			"return {",
			'\treporters = { "default", "json" },',
			"\toptions = {",
			"\t\tverbose = true,",
			"\t},",
			"}",
		].join("\n");

		expect(evalSource(source)).toStrictEqual({
			options: { verbose: true },
			reporters: ["default", "json"],
		});
	});
});
