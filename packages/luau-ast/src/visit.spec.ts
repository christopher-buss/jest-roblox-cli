import { fromAny } from "@total-typescript/shoehorn";

import { assert, describe, expect, it, vi } from "vitest";

import type { AstStatBlock } from "./ast.ts";
import { loadLuauParser } from "./parser.ts";
import type { LuauVisitor } from "./visit.ts";
import { visitBlock, visitExpression, visitStatement } from "./visit.ts";

function parseBlock(source: string): AstStatBlock {
	const result = loadLuauParser().parse(source);
	assert(result.ok);
	return result.root;
}

describe(visitBlock, () => {
	it("should call visitStatBlock and visitStatBlockEnd around the root", async () => {
		expect.assertions(2);

		const root = parseBlock("local x = 1");
		const enter = vi.fn<() => boolean>(() => true);
		const leave = vi.fn<() => void>();

		visitBlock(root, { visitStatBlock: enter, visitStatBlockEnd: leave });

		expect(enter).toHaveBeenCalledOnce();
		expect(leave).toHaveBeenCalledOnce();
	});

	it("should skip children when visitStatBlock returns false", async () => {
		expect.assertions(1);

		const root = parseBlock("local x = 1");
		const onLocal = vi.fn<() => boolean>(() => true);

		visitBlock(root, { visitStatBlock: () => false, visitStatLocal: onLocal });

		expect(onLocal).not.toHaveBeenCalled();
	});

	it("should dispatch each statement kind to its callback", async () => {
		expect.assertions(1);

		const root = parseBlock(
			[
				"local x = 1",
				"x = 2",
				"x += 1",
				"do end",
				"while x do break end",
				"repeat continue until x",
				"for i = 1, 2 do end",
				"for k, v in x do end",
				"if x then elseif x then else end",
				"function x.method() end",
				"local function helper() end",
				"type Alias = number",
				"print(x)",
				"return x",
			].join("\n"),
		);
		const seen: Array<string> = [];
		function see(name: string) {
			return () => {
				seen.push(name);
				return true;
			};
		}

		visitBlock(root, {
			visitStatAssign: see("assign"),
			visitStatBreak: see("break"),
			visitStatCompoundAssign: see("compound"),
			visitStatContinue: see("continue"),
			visitStatExpr: see("expr"),
			visitStatFor: see("for"),
			visitStatForIn: see("forin"),
			visitStatFunction: see("function"),
			visitStatIf: see("if"),
			visitStatLocal: see("local"),
			visitStatLocalFunction: see("localfunction"),
			visitStatRepeat: see("repeat"),
			visitStatReturn: see("return"),
			visitStatTypeAlias: see("typealias"),
			visitStatWhile: see("while"),
		});

		expect(seen).toStrictEqual([
			"local",
			"assign",
			"compound",
			"while",
			"break",
			"repeat",
			"continue",
			"for",
			"forin",
			"if",
			"if",
			"function",
			"localfunction",
			"typealias",
			"expr",
			"return",
		]);
	});
});

describe(visitExpression, () => {
	it("should dispatch each expression kind to its callback", async () => {
		expect.assertions(1);

		const root = parseBlock(
			[
				"local a = 1 + 2",
				"local b = f(a)",
				"local c = true",
				"local d = nil",
				"local e = 3",
				'local s = "text"',
				"local fn = function() end",
				"local g = globalValue",
				"local h = (a)",
				"local i = if a then b else c",
				"local j = t[a]",
				"local k = t.name",
				"local m = `interp {a}`",
				"local n = a",
				"local o = { 1 }",
				"local p = a :: number",
				"local q = -a",
				"local r = ...",
			].join("\n"),
		);
		const seen = new Set<string>();
		function see(name: string) {
			return () => {
				seen.add(name);
				return true;
			};
		}

		visitBlock(root, {
			visitExprBinary: see("binary"),
			visitExprCall: see("call"),
			visitExprConstantBool: see("bool"),
			visitExprConstantNil: see("nil"),
			visitExprConstantNumber: see("number"),
			visitExprConstantString: see("string"),
			visitExprFunction: see("function"),
			visitExprGlobal: see("global"),
			visitExprGroup: see("group"),
			visitExprIfElse: see("ifelse"),
			visitExprIndexExpr: see("indexexpr"),
			visitExprIndexName: see("indexname"),
			visitExprInterpString: see("interp"),
			visitExprLocal: see("local"),
			visitExprTable: see("table"),
			visitExprTypeAssertion: see("assertion"),
			visitExprUnary: see("unary"),
			visitExprVarargs: see("varargs"),
		});

		expect([...seen].sort()).toStrictEqual([
			"assertion",
			"binary",
			"bool",
			"call",
			"function",
			"global",
			"group",
			"ifelse",
			"indexexpr",
			"indexname",
			"interp",
			"local",
			"nil",
			"number",
			"string",
			"table",
			"unary",
			"varargs",
		]);
	});

	it("should stop the whole subtree when visitExpr returns false", async () => {
		expect.assertions(2);

		const root = parseBlock("local a = 1 + 2");
		const onNumber = vi.fn<() => boolean>(() => true);
		const onEnd = vi.fn<() => void>();

		visitBlock(root, {
			visitExpr: () => false,
			visitExprConstantNumber: onNumber,
			visitExprEnd: onEnd,
		});

		expect(onNumber).not.toHaveBeenCalled();
		expect(onEnd).not.toHaveBeenCalled();
	});

	it("should call visitExprEnd after each expression", async () => {
		expect.assertions(1);

		const root = parseBlock("local a = 1 + 2");
		const onEnd = vi.fn<() => void>();

		visitBlock(root, { visitExprEnd: onEnd });

		// The binary itself plus its two operands.
		expect(onEnd).toHaveBeenCalledTimes(3);
	});

	it("should call visitExprFunctionEnd after the function body", async () => {
		expect.assertions(1);

		const root = parseBlock("local fn = function() end");
		const order: Array<string> = [];

		visitBlock(root, {
			visitExprFunctionEnd: () => {
				order.push("functionEnd");
			},
			visitStatBlockEnd: () => {
				order.push("blockEnd");
			},
		});

		expect(order).toStrictEqual(["blockEnd", "functionEnd", "blockEnd"]);
	});

	it("should ignore an expression kind it does not model", () => {
		expect.assertions(1);

		const onEnd = vi.fn<() => void>();

		visitExpression(fromAny({ type: "AstExprError" }), { visitExprEnd: onEnd });

		expect(onEnd).toHaveBeenCalledOnce();
	});
});

describe(visitStatement, () => {
	it("should ignore a statement kind it does not model", () => {
		expect.assertions(1);

		const visitor: LuauVisitor = {};

		expect(() => {
			visitStatement(fromAny({ type: "AstStatDeclareGlobal" }), visitor);
		}).not.toThrow();
	});
});

describe("skipping children", () => {
	it.for([
		{ enter: "visitExprBinary", leaf: "visitExprConstantNumber", source: "local a = 1 + 2" },
		{ enter: "visitExprCall", leaf: "visitExprConstantNumber", source: "f(1)" },
		{
			enter: "visitExprFunction",
			leaf: "visitExprConstantNumber",
			source: "local f = function() return 1 end",
		},
		{ enter: "visitExprGroup", leaf: "visitExprConstantNumber", source: "local a = (1)" },
		{
			enter: "visitExprIfElse",
			leaf: "visitExprConstantNumber",
			source: "local a = if b then 1 else 2",
		},
		{ enter: "visitExprIndexExpr", leaf: "visitExprConstantNumber", source: "local a = t[1]" },
		{ enter: "visitExprIndexName", leaf: "visitExprGlobal", source: "local a = t.x" },
		{
			enter: "visitExprInterpString",
			leaf: "visitExprConstantNumber",
			source: "local a = `x{1}`",
		},
		{ enter: "visitExprTable", leaf: "visitExprConstantNumber", source: "local a = { 1 }" },
		{ enter: "visitTableItem", leaf: "visitExprConstantNumber", source: "local a = { 1 }" },
		{
			enter: "visitExprTypeAssertion",
			leaf: "visitExprConstantNumber",
			source: "local a = 1 :: number",
		},
		{ enter: "visitExprUnary", leaf: "visitExprConstantNumber", source: "local a = -1" },
		{ enter: "visitStatAssign", leaf: "visitExprConstantNumber", source: "a = 1" },
		{ enter: "visitStatCompoundAssign", leaf: "visitExprConstantNumber", source: "a += 1" },
		{ enter: "visitStatExpr", leaf: "visitExprCall", source: "f(1)" },
		{ enter: "visitStatFor", leaf: "visitExprConstantNumber", source: "for i = 1, 2 do end" },
		{ enter: "visitStatForIn", leaf: "visitExprGlobal", source: "for k in f do end" },
		{ enter: "visitStatFunction", leaf: "visitExprIndexName", source: "function t.m() end" },
		{ enter: "visitStatIf", leaf: "visitExprGlobal", source: "if a then end" },
		{ enter: "visitStatLocal", leaf: "visitExprConstantNumber", source: "local a = 1" },
		{
			enter: "visitStatLocalFunction",
			leaf: "visitExprConstantNumber",
			source: "local function f() return 1 end",
		},
		{ enter: "visitStatRepeat", leaf: "visitExprGlobal", source: "repeat until a" },
		{ enter: "visitStatReturn", leaf: "visitExprConstantNumber", source: "return 1" },
		{ enter: "visitStatWhile", leaf: "visitExprGlobal", source: "while a do end" },
	] as const)(
		"should skip children when $enter returns false over `$source`",
		async ({ enter, leaf, source }) => {
			expect.assertions(1);

			const root = parseBlock(source);
			const probe = vi.fn<() => boolean>(() => true);

			visitBlock(root, { [enter]: () => false, [leaf]: probe });

			expect(probe).not.toHaveBeenCalled();
		},
	);
});

describe("optional branches", () => {
	it("should visit the step expression when the numeric for has one", async () => {
		expect.assertions(1);

		const root = parseBlock("for i = 1, 10, 2 do end");
		const onNumber = vi.fn<() => boolean>(() => true);

		visitBlock(root, { visitExprConstantNumber: onNumber });

		expect(onNumber).toHaveBeenCalledTimes(3);
	});

	it("should visit computed table keys", async () => {
		expect.assertions(1);

		const root = parseBlock("local t = { [a] = 1 }");
		const onGlobal = vi.fn<() => boolean>(() => true);

		visitBlock(root, { visitExprGlobal: onGlobal });

		expect(onGlobal).toHaveBeenCalledOnce();
	});

	it("should recurse into a plain else block", async () => {
		expect.assertions(1);

		const root = parseBlock("if a then else b() end");
		const onCall = vi.fn<() => boolean>(() => true);

		visitBlock(root, { visitExprCall: onCall });

		expect(onCall).toHaveBeenCalledOnce();
	});

	it("should recurse through an elseif chain", async () => {
		expect.assertions(1);

		const root = parseBlock("if a then elseif b then elseif c then end");
		const onIf = vi.fn<() => boolean>(() => true);

		visitBlock(root, { visitStatIf: onIf });

		expect(onIf).toHaveBeenCalledTimes(3);
	});
});
