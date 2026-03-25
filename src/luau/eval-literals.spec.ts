import { describe, expect, it } from "vitest";

import type { AstStatBlock } from "./ast-types.ts";
import { evalLuauReturnLiterals } from "./eval-literals.ts";

function makeBlock(...statements: Array<unknown>): AstStatBlock {
	return {
		kind: "stat",
		location: { begincolumn: 1, beginline: 1, endcolumn: 1, endline: 1 },
		statements,
		tag: "block",
	} as AstStatBlock;
}

function makeReturn(...expressions: Array<unknown>) {
	return {
		expressions: expressions.map((node) => ({ node })),
		kind: "stat",
		location: { begincolumn: 1, beginline: 1, endcolumn: 1, endline: 1 },
		tag: "return",
	};
}

describe(evalLuauReturnLiterals, () => {
	it("should return string literal", () => {
		expect.assertions(1);

		const root = makeBlock(
			makeReturn({ kind: "expr", location: {}, tag: "string", text: "hello" }),
		);

		expect(evalLuauReturnLiterals(root)).toBe("hello");
	});

	it("should return boolean literal", () => {
		expect.assertions(1);

		const root = makeBlock(
			makeReturn({ kind: "expr", location: {}, tag: "boolean", value: true }),
		);

		expect(evalLuauReturnLiterals(root)).toBeTrue();
	});

	it("should return number literal", () => {
		expect.assertions(1);

		const root = makeBlock(
			makeReturn({ kind: "expr", location: {}, tag: "number", value: 42 }),
		);

		expect(evalLuauReturnLiterals(root)).toBe(42);
	});

	it("should return nil as undefined", () => {
		expect.assertions(1);

		const root = makeBlock(makeReturn({ kind: "expr", location: {}, tag: "nil" }));

		expect(evalLuauReturnLiterals(root)).toBeUndefined();
	});

	it("should evaluate record table to object", () => {
		expect.assertions(1);

		const root = makeBlock(
			makeReturn({
				entries: [
					{
						key: { text: "name" },
						kind: "record",
						value: { kind: "expr", location: {}, tag: "string", text: "test" },
					},
					{
						key: { text: "enabled" },
						kind: "record",
						value: { kind: "expr", location: {}, tag: "boolean", value: true },
					},
				],
				kind: "expr",
				location: {},
				tag: "table",
			}),
		);

		expect(evalLuauReturnLiterals(root)).toStrictEqual({
			name: "test",
			enabled: true,
		});
	});

	it("should evaluate list table to array", () => {
		expect.assertions(1);

		const root = makeBlock(
			makeReturn({
				entries: [
					{
						kind: "list",
						value: { kind: "expr", location: {}, tag: "string", text: "a" },
					},
					{
						kind: "list",
						value: { kind: "expr", location: {}, tag: "string", text: "b" },
					},
				],
				kind: "expr",
				location: {},
				tag: "table",
			}),
		);

		expect(evalLuauReturnLiterals(root)).toStrictEqual(["a", "b"]);
	});

	it("should evaluate empty table to empty object", () => {
		expect.assertions(1);

		const root = makeBlock(
			makeReturn({
				entries: [],
				kind: "expr",
				location: {},
				tag: "table",
			}),
		);

		expect(evalLuauReturnLiterals(root)).toStrictEqual({});
	});

	it("should unwrap cast expressions", () => {
		expect.assertions(1);

		const root = makeBlock(
			makeReturn({
				kind: "expr",
				location: {},
				operand: {
					entries: [
						{
							key: { text: "x" },
							kind: "record",
							value: { kind: "expr", location: {}, tag: "number", value: 1 },
						},
					],
					kind: "expr",
					location: {},
					tag: "table",
				},
				tag: "cast",
			}),
		);

		expect(evalLuauReturnLiterals(root)).toStrictEqual({ x: 1 });
	});

	it("should throw when root is not an object", () => {
		expect.assertions(1);

		expect(() => evalLuauReturnLiterals(null)).toThrowWithMessage(
			Error,
			"Config file has no return statement",
		);
	});

	it("should return undefined when return expression node is not an object", () => {
		expect.assertions(1);

		const root = makeBlock({
			expressions: [{ node: 42 }],
			kind: "stat",
			location: {},
			tag: "return",
		});

		expect(evalLuauReturnLiterals(root)).toBeUndefined();
	});

	it("should return undefined for non-object entries in list table", () => {
		expect.assertions(1);

		const root = makeBlock(
			makeReturn({
				entries: [
					{
						kind: "list",
						value: { kind: "expr", location: {}, tag: "string", text: "a" },
					},
					"not-an-object",
				],
				kind: "expr",
				location: {},
				tag: "table",
			}),
		);

		expect(evalLuauReturnLiterals(root)).toStrictEqual(["a", undefined]);
	});

	it("should skip record entries with non-string key", () => {
		expect.assertions(1);

		const root = makeBlock(
			makeReturn({
				entries: [
					{
						key: 42,
						kind: "record",
						value: { kind: "expr", location: {}, tag: "number", value: 1 },
					},
				],
				kind: "expr",
				location: {},
				tag: "table",
			}),
		);

		expect(evalLuauReturnLiterals(root)).toStrictEqual({});
	});

	it("should skip non-record entries in record table", () => {
		expect.assertions(1);

		const root = makeBlock(
			makeReturn({
				entries: [
					{
						key: { text: "kept" },
						kind: "record",
						value: { kind: "expr", location: {}, tag: "number", value: 1 },
					},
					"not-an-object",
				],
				kind: "expr",
				location: {},
				tag: "table",
			}),
		);

		expect(evalLuauReturnLiterals(root)).toStrictEqual({ kept: 1 });
	});

	it("should throw when no return statement exists", () => {
		expect.assertions(1);

		const root = makeBlock();

		expect(() => evalLuauReturnLiterals(root)).toThrowWithMessage(
			Error,
			"Config file has no return statement",
		);
	});

	it("should throw when return has no expressions", () => {
		expect.assertions(1);

		const root = makeBlock({
			expressions: [],
			kind: "stat",
			location: {},
			tag: "return",
		});

		expect(() => evalLuauReturnLiterals(root)).toThrowWithMessage(
			Error,
			"Return statement has no expressions",
		);
	});

	it("should return undefined for unsupported expression types", () => {
		expect.assertions(1);

		const root = makeBlock(makeReturn({ kind: "expr", location: {}, tag: "call" }));

		expect(evalLuauReturnLiterals(root)).toBeUndefined();
	});

	it("should evaluate nested tables", () => {
		expect.assertions(1);

		const root = makeBlock(
			makeReturn({
				entries: [
					{
						key: { text: "nested" },
						kind: "record",
						value: {
							entries: [
								{
									key: { text: "deep" },
									kind: "record",
									value: { kind: "expr", location: {}, tag: "number", value: 99 },
								},
							],
							kind: "expr",
							location: {},
							tag: "table",
						},
					},
				],
				kind: "expr",
				location: {},
				tag: "table",
			}),
		);

		expect(evalLuauReturnLiterals(root)).toStrictEqual({ nested: { deep: 99 } });
	});
});
