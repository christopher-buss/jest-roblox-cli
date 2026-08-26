import type {
	AstExprBinary,
	AstExprFunction,
	AstExprIfElse,
	AstStatBlock,
	AstStatFunction,
	AstStatIf,
	AstStatLocalFunction,
	LuauSpan,
} from "@isentinel/luau-ast/ast";
import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it } from "vitest";

import { createBranchCollector } from "./collect-branches.ts";
import { createFunctionCollector, getBodyFirstStatement } from "./collect-functions.ts";
import { createStatementCollector } from "./collect-statements.ts";
import { createCoverageAccumulator } from "./coverage-accumulator.ts";

function span(line: number): LuauSpan {
	return { beginColumn: 1, beginLine: line, endColumn: 5, endLine: line };
}

function block(line: number, body: Array<unknown> = []): AstStatBlock {
	return fromAny<AstStatBlock, unknown>({ body, location: span(line), type: "AstStatBlock" });
}

describe(createStatementCollector, () => {
	it("should collect every instrumentable statement type and ignore metadata nodes", () => {
		expect.assertions(2);

		const accumulator = createCoverageAccumulator();
		const collector = createStatementCollector(accumulator);
		const types = [
			"AstStatAssign",
			"AstStatBlock",
			"AstStatBreak",
			"AstStatCompoundAssign",
			"AstStatContinue",
			"AstStatExpr",
			"AstStatFor",
			"AstStatForIn",
			"AstStatFunction",
			"AstStatIf",
			"AstStatLocal",
			"AstStatLocalFunction",
			"AstStatRepeat",
			"AstStatReturn",
			"AstStatWhile",
		];
		const statements = [...types, "AstComment"].map((type, index) => {
			return {
				location: span(index + 1),
				type,
			};
		});

		expect(collector.visitStatBlock!(block(99, statements))).toBeTrue();
		expect(accumulator.result().statements).toStrictEqual(
			types.map((_, index) => ({ index: index + 1, location: span(index + 1) })),
		);
	});
});

describe(createFunctionCollector, () => {
	it("should name functions, preserve traversal, and avoid counting named expressions twice", () => {
		expect.assertions(2);

		const accumulator = createCoverageAccumulator();
		const collector = createFunctionCollector(accumulator);
		const namedExpression = fromAny<AstExprFunction, unknown>({
			body: block(11, [{ location: span(12), type: "AstStatReturn" }]),
			location: span(10),
			type: "AstExprFunction",
		});
		const named = fromAny<AstStatFunction, unknown>({
			name: {
				expr: { global: "service", type: "AstExprGlobal" },
				index: "start",
				op: ".",
				type: "AstExprIndexName",
			},
			func: namedExpression,
			location: span(9),
			type: "AstStatFunction",
		});
		const localExpression = fromAny<AstExprFunction, unknown>({
			body: block(21),
			location: span(20),
			type: "AstExprFunction",
		});
		const local = fromAny<AstStatLocalFunction, unknown>({
			name: { name: "helper" },
			func: localExpression,
			location: span(19),
			type: "AstStatLocalFunction",
		});
		const anonymous = fromAny<AstExprFunction, unknown>({
			body: block(31),
			location: span(30),
			type: "AstExprFunction",
		});

		expect([
			collector.visitStatFunction!(named),
			collector.visitExprFunction!(namedExpression),
			collector.visitStatLocalFunction!(local),
			collector.visitExprFunction!(localExpression),
			collector.visitExprFunction!(anonymous),
		]).toStrictEqual([true, true, true, true, true]);
		expect(accumulator.result().functions).toStrictEqual([
			{
				name: "service.start",
				bodyFirstColumn: 1,
				bodyFirstLine: 12,
				index: 1,
				location: span(9),
			},
			{
				name: "helper",
				bodyFirstColumn: 1,
				bodyFirstLine: 21,
				index: 2,
				location: span(19),
			},
			{
				name: "(anonymous)",
				bodyFirstColumn: 1,
				bodyFirstLine: 31,
				index: 3,
				location: span(30),
			},
		]);
	});

	it("should use the block position for an empty function body", () => {
		expect.assertions(1);

		expect(getBodyFirstStatement(block(42))).toStrictEqual({ column: 1, line: 42 });
	});
});

describe(createBranchCollector, () => {
	it("should collect short-circuit, expression-if, and statement-if arms", () => {
		expect.assertions(2);

		const accumulator = createCoverageAccumulator();
		const collector = createBranchCollector(accumulator);
		const binary = fromAny<AstExprBinary, unknown>({
			left: { location: span(1) },
			op: "And",
			right: { location: span(2) },
		});
		const arithmetic = fromAny<AstExprBinary, unknown>({
			left: { location: span(8) },
			op: "Add",
			right: { location: span(9) },
		});
		const expressionIf = fromAny<AstExprIfElse, unknown>({
			falseExpr: { location: span(4), type: "AstExprConstantNil" },
			trueExpr: { location: span(3) },
		});
		const statementIf = fromAny<AstStatIf, unknown>({
			elsebody: block(7),
			location: span(5),
			thenbody: block(6),
		});

		expect([
			collector.visitExprBinary!(arithmetic),
			collector.visitExprBinary!(binary),
			collector.visitExprIfElse!(expressionIf),
			collector.visitStatIf!(statementIf),
			collector.visitStatIf!(statementIf),
		]).toStrictEqual([true, true, true, true, true]);
		expect(accumulator.result().branches).toStrictEqual([
			expect.objectContaining({ branchType: "binary-expr", index: 1 }),
			expect.objectContaining({ branchType: "expr-if", index: 2 }),
			{
				arms: [
					{ bodyFirstColumn: 1, bodyFirstLine: 6, location: span(6) },
					{ bodyFirstColumn: 1, bodyFirstLine: 7, location: span(7) },
				],
				branchType: "if",
				index: 3,
			},
			{
				arms: [
					{ bodyFirstColumn: 1, bodyFirstLine: 6, location: span(6) },
					{ bodyFirstColumn: 1, bodyFirstLine: 7, location: span(7) },
				],
				branchType: "if",
				index: 4,
			},
		]);
	});
});
