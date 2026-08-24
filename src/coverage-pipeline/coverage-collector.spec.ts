import type { LuauSpan } from "@isentinel/luau-ast/ast";

import { assert, describe, expect, it } from "vitest";

import { luauParser } from "../luau/parser.ts";
import type { CollectorResult } from "./coverage-collector.ts";
import { collectCoverage } from "./coverage-collector.ts";

function span(
	beginLine: number,
	beginColumn: number,
	endLine: number,
	endColumn: number,
): LuauSpan {
	return { beginColumn, beginLine, endColumn, endLine };
}

/** Parse real source and run the collector over it. */
function collect(source: string): CollectorResult {
	const parsed = luauParser.parse(source);
	assert(parsed.ok);
	return collectCoverage(parsed.root, source);
}

describe(collectCoverage, () => {
	describe("statements", () => {
		it("should return empty result for empty source", () => {
			expect.assertions(5);

			const result = collect("");

			expect(result.statements).toBeEmpty();
			expect(result.functions).toBeEmpty();
			expect(result.branches).toBeEmpty();
			expect(result.implicitElseProbes).toBeEmpty();
			expect(result.wrapProbes).toBeEmpty();
		});

		it("should collect instrumentable statements with 1-based indices", () => {
			expect.assertions(3);

			const result = collect("local x = 1\nprint(x)");

			expect(result.statements).toHaveLength(2);
			expect(result.statements[0]).toStrictEqual({
				index: 1,
				location: span(1, 1, 1, 12),
			});
			expect(result.statements[1]).toStrictEqual({
				index: 2,
				location: span(2, 1, 2, 9),
			});
		});

		it("should skip non-instrumentable statement kinds", () => {
			expect.assertions(1);

			const result = collect("type Alias = number");

			expect(result.statements).toBeEmpty();
		});
	});

	describe("functions", () => {
		it("should collect named functions from localfunction statements", () => {
			expect.assertions(3);

			const result = collect("local function greet()\n\treturn 1\nend");

			expect(result.functions).toHaveLength(1);
			expect(result.functions[0]!.name).toBe("greet");
			expect(result.functions[0]).toStrictEqual({
				name: "greet",
				bodyFirstColumn: 2,
				bodyFirstLine: 2,
				index: 1,
				location: span(1, 1, 3, 4),
			});
		});

		it("should fall back to (anonymous) when the function is named by a local", () => {
			expect.assertions(2);

			const result = collect("local obj\nfunction obj()\nend");

			expect(result.functions).toHaveLength(1);
			expect(result.functions[0]!.name).toBe("(anonymous)");
		});

		it("should collect named functions from global function statements", () => {
			expect.assertions(2);

			const result = collect("function globalFunc()\n\treturn 1\nend");

			expect(result.functions).toHaveLength(1);
			expect(result.functions[0]!.name).toBe("globalFunc");
		});

		it("should collect anonymous function expressions in local assignments", () => {
			expect.assertions(2);

			const result = collect("local f = function()\n\treturn 1\nend");

			expect(result.functions).toHaveLength(1);
			expect(result.functions[0]!.name).toBe("(anonymous)");
		});

		it("should extract dotted name from dot-method function", () => {
			expect.assertions(2);

			const result = collect("function Obj.method()\nend");

			expect(result.functions).toHaveLength(1);
			expect(result.functions[0]!.name).toBe("Obj.method");
		});

		it("should extract colon name from colon-method function", () => {
			expect.assertions(2);

			const result = collect("function Obj:method()\nend");

			expect(result.functions).toHaveLength(1);
			expect(result.functions[0]!.name).toBe("Obj:method");
		});

		it("should use body block start position for empty-body function", () => {
			expect.assertions(3);

			const result = collect("local function noop()\nend");

			expect(result.functions).toHaveLength(1);
			expect(result.functions[0]!.bodyFirstLine).toBe(1);
			expect(result.functions[0]!.bodyFirstColumn).toBe(22);
		});
	});

	describe("statement-if branches", () => {
		it("should collect if-else branches with then, elseif, and else arms", () => {
			expect.assertions(5);

			const result = collect(
				["if a then", "\tf()", "elseif b then", "\tg()", "else", "\th()", "end"].join("\n"),
			);

			expect(result.branches).toHaveLength(1);
			expect(result.branches[0]!.branchType).toBe("if");
			expect(result.branches[0]!.arms).toHaveLength(3);
			expect(result.branches[0]!.arms[0]!.bodyFirstLine).toBe(2);
			expect(result.implicitElseProbes).toBeEmpty();
		});

		it("should create implicit else probe for if without else", () => {
			expect.assertions(5);

			const result = collect("if a then\n\tf()\nend");

			expect(result.branches).toHaveLength(1);
			// then arm + implicit else arm
			expect(result.branches[0]!.arms).toHaveLength(2);
			expect(result.implicitElseProbes).toHaveLength(1);
			expect(result.implicitElseProbes[0]!.endLine).toBe(3);
			expect(result.implicitElseProbes[0]!.endColumn).toBe(1);
		});

		// The parser extends the if statement's location past a trailing `;`
		// (endColumn 5, past `end;`), but `end` starts at column 1. The
		// then-block's end reliably marks the start of `end`.
		it("should place implicit else probe at start of `end` when source has trailing semicolon", () => {
			expect.assertions(2);

			const result = collect("if a then\n\tf()\nend;");

			expect(result.implicitElseProbes[0]!.endLine).toBe(3);
			expect(result.implicitElseProbes[0]!.endColumn).toBe(1);
		});

		it("should place implicit else probe at start of `end` for if/elseif with trailing semicolon", () => {
			expect.assertions(2);

			const result = collect("if a then\n\tf()\nelseif b then\n\tg()\nend;");

			expect(result.implicitElseProbes[0]!.endLine).toBe(5);
			expect(result.implicitElseProbes[0]!.endColumn).toBe(1);
		});
	});

	describe("expression-if branches", () => {
		it("should collect expr-if branches with bodyFirstLine=0", () => {
			expect.assertions(5);

			const result = collect("local x = if a then 1 else 2");

			expect(result.branches).toHaveLength(1);
			expect(result.branches[0]!.branchType).toBe("expr-if");
			expect(result.branches[0]!.arms).toHaveLength(2);
			expect(result.branches[0]!.arms[0]!.bodyFirstLine).toBe(0);
			expect(result.branches[0]!.arms[1]!.bodyFirstLine).toBe(0);
		});

		it("should generate wrapProbes for each expr-if arm", () => {
			expect.assertions(3);

			const result = collect("local x = if a then 1 else 2");

			expect(result.wrapProbes).toHaveLength(2);
			expect(result.wrapProbes[0]).toStrictEqual({
				armIndex: 1,
				branchIndex: 1,
				exprLocation: span(1, 21, 1, 22),
			});
			expect(result.wrapProbes[1]).toStrictEqual({
				armIndex: 2,
				branchIndex: 1,
				exprLocation: span(1, 28, 1, 29),
			});
		});

		it("should collect expr-if with elseif arms", () => {
			expect.assertions(5);

			const result = collect('local x = if a then "a" elseif b then "b" else "c"');

			expect(result.branches).toHaveLength(1);
			expect(result.branches[0]!.branchType).toBe("expr-if");
			// 3 arms: then + elseif-then + else
			expect(result.branches[0]!.arms).toHaveLength(3);
			// 3 wrap probes: one per arm
			expect(result.wrapProbes).toHaveLength(3);
			expect(result.wrapProbes.map((probe) => probe.armIndex)).toStrictEqual([1, 2, 3]);
		});
	});

	describe("binary branches", () => {
		it("should collect an and expression as a binary-expr branch", () => {
			expect.assertions(5);

			const result = collect("local c = a and b");

			expect(result.branches).toHaveLength(1);
			expect(result.branches[0]!.branchType).toBe("binary-expr");
			expect(result.branches[0]!.arms).toHaveLength(2);
			expect(result.branches[0]!.arms.map((arm) => arm.location)).toStrictEqual([
				span(1, 11, 1, 12),
				span(1, 17, 1, 18),
			]);
			expect(result.wrapProbes).toStrictEqual([
				{ armIndex: 1, branchIndex: 1, exprLocation: span(1, 11, 1, 12) },
				{ armIndex: 2, branchIndex: 1, exprLocation: span(1, 17, 1, 18) },
			]);
		});

		it("should collect an or expression as a binary-expr branch", () => {
			expect.assertions(2);

			const result = collect("local c = p or q");

			expect(result.branches[0]!.branchType).toBe("binary-expr");
			expect(result.wrapProbes).toHaveLength(2);
		});

		it("should not treat a non-logical binary operator as a branch", () => {
			expect.assertions(2);

			const result = collect("local c = a + b");

			expect(result.branches).toBeEmpty();
			expect(result.wrapProbes).toBeEmpty();
		});

		it("should collect a left-associative and chain as two nested branches", () => {
			expect.assertions(3);

			// `a and b and c` parses as `(a and b) and c`. The outer node is
			// visited first (branch 1, arms = `a and b` and `c`), then the
			// inner (branch 2, arms = `a` and `b`).
			const result = collect("local c = a and b and c");

			expect(result.branches.map((branch) => branch.index)).toStrictEqual([1, 2]);
			expect(result.branches[0]!.arms.map((arm) => arm.location)).toStrictEqual([
				span(1, 11, 1, 18),
				span(1, 23, 1, 24),
			]);
			expect(result.branches[1]!.arms.map((arm) => arm.location)).toStrictEqual([
				span(1, 11, 1, 12),
				span(1, 17, 1, 18),
			]);
		});
	});
});
