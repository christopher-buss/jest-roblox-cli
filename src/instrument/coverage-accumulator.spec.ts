import type { LuauSpan } from "@isentinel/luau-ast/ast";

import { describe, expect, it } from "vitest";

import { createCoverageAccumulator } from "./coverage-accumulator.ts";

function span(line: number): LuauSpan {
	return { beginColumn: 1, beginLine: line, endColumn: 5, endLine: line };
}

describe(createCoverageAccumulator, () => {
	it("should start every counter empty", () => {
		expect.assertions(1);

		expect(createCoverageAccumulator().result()).toStrictEqual({
			branches: [],
			functions: [],
			implicitElseProbes: [],
			statements: [],
			wrapProbes: [],
		});
	});

	it("should number statements and functions from one and copy their spans", () => {
		expect.assertions(2);

		const accumulator = createCoverageAccumulator();
		const location = span(1);
		accumulator.addStatement(location);
		accumulator.addStatement(span(2));
		accumulator.addFunction({ name: "f", location, start: { column: 3, line: 4 } });
		location.beginLine = 99;

		expect(accumulator.result().statements).toStrictEqual([
			{ index: 1, location: span(1) },
			{ index: 2, location: span(2) },
		]);
		expect(accumulator.result().functions).toStrictEqual([
			{ name: "f", bodyFirstColumn: 3, bodyFirstLine: 4, index: 1, location: span(1) },
		]);
	});

	it("should give every expression arm the wrap sentinel and its own wrap probe", () => {
		expect.assertions(2);

		const accumulator = createCoverageAccumulator();
		accumulator.addExpressionBranch("binary-expr", [span(1), span(2)]);

		expect(accumulator.result().branches).toStrictEqual([
			{
				arms: [
					{ bodyFirstColumn: 0, bodyFirstLine: 0, location: span(1) },
					{ bodyFirstColumn: 0, bodyFirstLine: 0, location: span(2) },
				],
				branchType: "binary-expr",
				index: 1,
			},
		]);
		expect(accumulator.result().wrapProbes).toStrictEqual([
			{ armIndex: 1, branchIndex: 1, exprLocation: span(1) },
			{ armIndex: 2, branchIndex: 1, exprLocation: span(2) },
		]);
	});

	it("should append a synthetic arm and its probe for an implicit else", () => {
		expect.assertions(2);

		const accumulator = createCoverageAccumulator();
		accumulator.addExpressionBranch("expr-if", [span(1), span(2)]);
		accumulator.addStatementBranch([{ bodyFirst: { column: 2, line: 6 }, location: span(6) }], {
			ifStart: { column: 1, line: 5 },
			probeEnd: { column: 4, line: 7 },
		});

		expect(accumulator.result().branches[1]).toStrictEqual({
			arms: [
				{ bodyFirstColumn: 2, bodyFirstLine: 6, location: span(6) },
				{
					bodyFirstColumn: 0,
					bodyFirstLine: 0,
					location: { beginColumn: 1, beginLine: 5, endColumn: 1, endLine: 5 },
				},
			],
			branchType: "if",
			index: 2,
		});
		expect(accumulator.result().implicitElseProbes).toStrictEqual([
			{ armIndex: 2, branchIndex: 2, endColumn: 4, endLine: 7 },
		]);
	});

	it("should record no probe for a statement branch with a real else", () => {
		expect.assertions(1);

		const accumulator = createCoverageAccumulator();
		accumulator.addStatementBranch([
			{ bodyFirst: { column: 2, line: 6 }, location: span(6) },
			{ bodyFirst: { column: 2, line: 8 }, location: span(8) },
		]);

		expect(accumulator.result().implicitElseProbes).toStrictEqual([]);
	});

	it("should count functions and statement branches upward", () => {
		expect.assertions(2);

		const accumulator = createCoverageAccumulator();
		accumulator.addFunction({ name: "f", location: span(1), start: { column: 1, line: 1 } });
		accumulator.addFunction({ name: "g", location: span(2), start: { column: 1, line: 2 } });
		accumulator.addStatementBranch([{ bodyFirst: { column: 2, line: 6 }, location: span(6) }]);
		accumulator.addStatementBranch([{ bodyFirst: { column: 2, line: 8 }, location: span(8) }]);

		expect(accumulator.result().functions.map(({ index }) => index)).toStrictEqual([1, 2]);
		expect(accumulator.result().branches.map(({ index }) => index)).toStrictEqual([1, 2]);
	});
});
