import type {
	AstExprBinary,
	AstExprIfElse,
	AstStatBlock,
	AstStatIf,
	LuauSpan,
} from "@isentinel/luau-ast/ast";
import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it } from "vitest";

import { recordingAccumulator } from "#test/mocks/coverage-accumulator.ts";
import { block, NO_IGNORES, span } from "#test/mocks/coverage-spec-luau-ast.ts";
import { createBranchCollector } from "./collect-branches.ts";

interface Arm {
	bodyFirstColumn: number;
	bodyFirstLine: number;
	location: LuauSpan;
}

function statementIf({
	elsebody,
	line,
}: {
	elsebody?: AstStatBlock | AstStatIf;
	line: number;
}): AstStatIf {
	return fromAny<AstStatIf, unknown>({
		elsebody,
		location: span(line),
		thenbody: block(line + 1),
		type: "AstStatIf",
	});
}

function armAt(line: number): Arm {
	return { bodyFirstColumn: 1, bodyFirstLine: line, location: span(line) };
}

describe(createBranchCollector, () => {
	it("should collect short-circuit, expression-if, and statement-if arms", () => {
		expect.assertions(2);

		const accumulator = recordingAccumulator();
		const collector = createBranchCollector(accumulator, NO_IGNORES);
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
		const statement = fromAny<AstStatIf, unknown>({
			elsebody: block(7),
			location: span(5),
			thenbody: block(6),
		});

		expect([
			collector.visitExprBinary!(arithmetic),
			collector.visitExprBinary!(binary),
			collector.visitExprIfElse!(expressionIf),
			collector.visitStatIf!(statement),
			collector.visitStatIf!(statement),
		]).toStrictEqual([true, true, true, true, true]);
		expect(accumulator.result().branches).toStrictEqual([
			expect.objectContaining({ branchType: "binary-expr", index: 1 }),
			expect.objectContaining({ branchType: "expr-if", index: 2 }),
			{ arms: [armAt(6), armAt(7)], branchType: "if", index: 3 },
			{ arms: [armAt(6), armAt(7)], branchType: "if", index: 4 },
		]);
	});

	it("should fold an elseif expression chain into one branch", () => {
		expect.assertions(2);

		const accumulator = recordingAccumulator();
		const collector = createBranchCollector(accumulator, NO_IGNORES);
		const inner = fromAny<AstExprIfElse, unknown>({
			falseExpr: { location: span(3), type: "AstExprConstantNil" },
			trueExpr: { location: span(2) },
			type: "AstExprIfElse",
		});
		const outer = fromAny<AstExprIfElse, unknown>({
			falseExpr: inner,
			trueExpr: { location: span(1) },
			type: "AstExprIfElse",
		});

		collector.visitExprIfElse!(outer);
		collector.visitExprIfElse!(inner);

		expect(accumulator.result().branches).toHaveLength(1);
		expect(
			accumulator.result().wrapProbes.map(({ exprLocation }) => exprLocation),
		).toStrictEqual([span(1), span(2), span(3)]);
	});

	it("should fold an elseif statement chain into one branch", () => {
		expect.assertions(1);

		const accumulator = recordingAccumulator();
		const collector = createBranchCollector(accumulator, NO_IGNORES);
		const inner = statementIf({ elsebody: block(4), line: 2 });
		const outer = statementIf({ elsebody: inner, line: 0 });

		collector.visitStatIf!(outer);
		collector.visitStatIf!(inner);

		expect(accumulator.result().branches).toStrictEqual([
			{ arms: [armAt(1), armAt(3), armAt(4)], branchType: "if", index: 1 },
		]);
	});

	it("should add a synthetic arm and probe for an if without else", () => {
		expect.assertions(2);

		const accumulator = recordingAccumulator();
		const collector = createBranchCollector(accumulator, NO_IGNORES);

		collector.visitStatIf!(statementIf({ line: 5 }));

		expect(accumulator.result().branches[0]!.arms).toHaveLength(2);
		expect(accumulator.result().implicitElseProbes).toStrictEqual([
			{ armIndex: 2, branchIndex: 1, endColumn: 5, endLine: 6 },
		]);
	});

	it("should add no synthetic arm when the ignores drop the implicit else", () => {
		expect.assertions(2);

		const accumulator = recordingAccumulator();
		const collector = createBranchCollector(accumulator, {
			...NO_IGNORES,
			dropsImplicitElse: () => true,
		});

		collector.visitStatIf!(statementIf({ line: 5 }));

		expect(accumulator.result().branches).toStrictEqual([
			{ arms: [armAt(6)], branchType: "if", index: 1 },
		]);
		expect(accumulator.result().implicitElseProbes).toStrictEqual([]);
	});

	it("should record no branch when the ignores cover every arm", () => {
		expect.assertions(1);

		const accumulator = recordingAccumulator();
		const collector = createBranchCollector(accumulator, {
			...NO_IGNORES,
			covers: (location) => location.beginLine !== 5,
		});

		collector.visitStatIf!(statementIf({ elsebody: block(7), line: 5 }));

		expect(accumulator.result().branches).toStrictEqual([]);
	});

	it("should skip nodes the ignores cover", () => {
		expect.assertions(2);

		const accumulator = recordingAccumulator();
		const collector = createBranchCollector(accumulator, {
			...NO_IGNORES,
			covers: () => true,
		});

		expect([
			collector.visitExprBinary!(
				fromAny<AstExprBinary, unknown>({
					left: { location: span(1) },
					location: span(1),
					op: "Or",
					right: { location: span(2) },
				}),
			),
			collector.visitExprIfElse!(
				fromAny<AstExprIfElse, unknown>({
					falseExpr: { location: span(4), type: "AstExprConstantNil" },
					location: span(3),
					trueExpr: { location: span(3) },
				}),
			),
			collector.visitStatIf!(statementIf({ line: 5 })),
		]).toStrictEqual([true, true, true]);
		expect(accumulator.result().branches).toStrictEqual([]);
	});
});
