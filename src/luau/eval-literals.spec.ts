import type { AstStatBlock } from "@isentinel/luau-ast/ast";

import { assert, describe, expect, it } from "vitest";

import type { LuauLiteral, LuauStaticEvaluation } from "./eval-literals.ts";
import { evalLuauReturnLiterals } from "./eval-literals.ts";
import { luauParser } from "./parser.ts";

function parseBlock(source: string): AstStatBlock {
	const parsed = luauParser.parse(source);
	assert(parsed.ok);
	return parsed.root;
}

function evalSource(source: string): LuauStaticEvaluation {
	return evalLuauReturnLiterals(parseBlock(source));
}

function evalValue(source: string): LuauLiteral {
	const evaluation = evalSource(source);
	assert(evaluation.kind === "value", "expected the source to read statically");
	return evaluation.value;
}

describe(evalLuauReturnLiterals, () => {
	it("should return string literal", () => {
		expect.assertions(1);

		expect(evalValue('return "hello"')).toBe("hello");
	});

	it("should return boolean literal", () => {
		expect.assertions(1);

		expect(evalValue("return true")).toBeTrue();
	});

	it("should return number literal", () => {
		expect.assertions(1);

		expect(evalValue("return 42")).toBe(42);
	});

	it("should return nil as undefined", () => {
		expect.assertions(1);

		expect(evalValue("return nil")).toBeUndefined();
	});

	it("should evaluate record table to object", () => {
		expect.assertions(1);

		expect(evalValue('return {\n\ttimeout = 5,\n\tname = "suite",\n}')).toStrictEqual({
			name: "suite",
			timeout: 5,
		});
	});

	it("should evaluate literal string keys written in brackets", () => {
		expect.assertions(1);

		expect(
			evalValue('return { ["displayName"] = "suite", ["test-timeout"] = 5 }'),
		).toStrictEqual({
			"displayName": "suite",
			"test-timeout": 5,
		});
	});

	it("should leave out a record entry whose value is nil", () => {
		expect.assertions(1);

		expect(evalValue('return { name = "kept", skipped = nil }')).toStrictEqual({
			name: "kept",
		});
	});

	it("should evaluate list table to array", () => {
		expect.assertions(1);

		expect(evalValue('return { "a", "b", 3 }')).toStrictEqual(["a", "b", 3]);
	});

	it("should evaluate empty table to empty object", () => {
		expect.assertions(1);

		expect(evalValue("return {}")).toStrictEqual({});
	});

	it("should unwrap cast expressions", () => {
		expect.assertions(1);

		expect(evalValue("return 5 :: number")).toBe(5);
	});

	it("should unwrap parenthesized and nested cast expressions", () => {
		expect.assertions(1);

		expect(evalValue("return (5 :: any) :: number")).toBe(5);
	});

	it("should pass the argument of a defineConfig call through", () => {
		expect.assertions(1);

		expect(evalValue("return defineConfig({ timeout = 5 })")).toStrictEqual({ timeout: 5 });
	});

	it("should pass the argument of a module's defineConfig call through", () => {
		expect.assertions(1);

		const source = [
			'local jest = require("@jest-roblox/config")',
			"return jest.defineConfig({ timeout = 5 }) :: jest.Config",
		].join("\n");

		expect(evalValue(source)).toStrictEqual({ timeout: 5 });
	});

	it("should pass the argument of a global module's defineConfig call through", () => {
		expect.assertions(1);

		expect(evalValue("return jest.defineConfig({ timeout = 5 })")).toStrictEqual({
			timeout: 5,
		});
	});

	it("should pass the argument of a local defineConfig call through", () => {
		expect.assertions(1);

		const source = [
			'local defineConfig = require("@jest-roblox/config").defineConfig',
			"return defineConfig({ timeout = 5 })",
		].join("\n");

		expect(evalValue(source)).toStrictEqual({ timeout: 5 });
	});

	it("should ignore the statements before the return", () => {
		expect.assertions(1);

		const source = [
			'local jest = require("@jest-roblox/config")',
			"type Config = jest.Config",
			"return { timeout = 5 }",
		].join("\n");

		expect(evalValue(source)).toStrictEqual({ timeout: 5 });
	});

	it("should read a file with no return statement as nil", () => {
		expect.assertions(1);

		expect(evalValue("local x = 1")).toBeUndefined();
	});

	it("should read a bare return as nil", () => {
		expect.assertions(1);

		expect(evalValue("return")).toBeUndefined();
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

		expect(evalValue(source)).toStrictEqual({
			options: { verbose: true },
			reporters: ["default", "json"],
		});
	});

	it("should stop at a function call and name its line", () => {
		expect.assertions(1);

		expect(evalSource("return {\n\ttimeout = getTimeout(),\n}")).toStrictEqual({
			kind: "unreadable",
			line: 2,
			syntax: "a function call",
		});
	});

	it("should stop at an unreadable entry in a list table", () => {
		expect.assertions(1);

		expect(evalSource("return { someFunction(), 2 }")).toStrictEqual({
			kind: "unreadable",
			line: 1,
			syntax: "a function call",
		});
	});

	it("should stop at a defineConfig call with more than one argument", () => {
		expect.assertions(1);

		expect(evalSource("return defineConfig({}, {})")).toStrictEqual({
			kind: "unreadable",
			line: 1,
			syntax: "a function call",
		});
	});

	it("should stop at a defineConfig method call", () => {
		expect.assertions(1);

		expect(evalSource("return jest:defineConfig({})")).toStrictEqual({
			kind: "unreadable",
			line: 1,
			syntax: "a function call",
		});
	});

	it("should stop at a one-argument call to another global", () => {
		expect.assertions(1);

		expect(evalSource("return wrap({ timeout = 5 })")).toStrictEqual({
			kind: "unreadable",
			line: 1,
			syntax: "a function call",
		});
	});

	it("should stop at a one-argument call to another local", () => {
		expect.assertions(1);

		const source = ["local wrap = require(script.Wrap)", "return wrap({ timeout = 5 })"].join(
			"\n",
		);

		expect(evalSource(source)).toStrictEqual({
			kind: "unreadable",
			line: 2,
			syntax: "a function call",
		});
	});

	it("should stop at a one-argument call to another module function", () => {
		expect.assertions(1);

		expect(evalSource("return jest.wrap({ timeout = 5 })")).toStrictEqual({
			kind: "unreadable",
			line: 1,
			syntax: "a function call",
		});
	});

	it("should stop at a reference to a local", () => {
		expect.assertions(1);

		expect(evalSource("local config = {}\nreturn config")).toStrictEqual({
			kind: "unreadable",
			line: 2,
			syntax: "a local variable",
		});
	});

	it("should stop at a computed record key", () => {
		expect.assertions(1);

		expect(evalSource('return {\n\tname = "kept",\n\t[key] = 1,\n}')).toStrictEqual({
			kind: "unreadable",
			line: 3,
			syntax: "a table key that is not a string literal",
		});
	});

	it("should stop at a table that starts as a record and holds a list entry", () => {
		expect.assertions(1);

		expect(evalSource('return { name = "a",\n"b" }')).toStrictEqual({
			kind: "unreadable",
			line: 2,
			syntax: "a table that mixes list and record entries",
		});
	});

	it("should stop at a table that starts as a list and holds a record entry", () => {
		expect.assertions(1);

		expect(evalSource('return { "a",\nname = "b" }')).toStrictEqual({
			kind: "unreadable",
			line: 2,
			syntax: "a table that mixes list and record entries",
		});
	});

	it.for([
		["return 1 + 2", "an operator"],
		["return -1", "an operator"],
		['return `{"a"}`', "an interpolated string"],
		["return if x then 1 else 2", "an if-expression"],
		["return function() end", "a function"],
		["return os.getenv", "an index"],
		["return t[1]", "an index"],
		["return ...", "a vararg"],
		["return config", "a global variable"],
	] as const)("should stop at %j and name the syntax", ([source, syntax]) => {
		expect.assertions(1);

		expect(evalSource(source)).toStrictEqual({ kind: "unreadable", line: 1, syntax });
	});

	it("should ignore an if statement before the return", () => {
		expect.assertions(1);

		const source = [
			'local jest = require("@jest-roblox/config")',
			'if os.getenv("CI") then',
			"\treturn { test = { ci = true } }",
			"end",
			"return {}",
		].join("\n");

		expect(evalValue(source)).toStrictEqual({});
	});

	it.for([
		"while true do end",
		"repeat until true",
		"for i = 1, 2 do end",
		"for _ in {} do end",
		"do end",
	])("should ignore %j before the return", (statement) => {
		expect.assertions(1);

		expect(evalValue(`${statement}\nreturn {}`)).toStrictEqual({});
	});

	it.for(["getConfig().defineConfig", "config.helpers.defineConfig", "config[1].defineConfig"])(
		"should reject a computed helper receiver in %s",
		(helper) => {
			expect.assertions(1);

			expect(evalSource(`return ${helper}({})`)).toStrictEqual({
				kind: "unreadable",
				line: 1,
				syntax: "a function call",
			});
		},
	);
});
