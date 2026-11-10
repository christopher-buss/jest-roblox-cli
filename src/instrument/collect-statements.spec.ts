import { describe, expect, it } from "vitest";

import { recordingAccumulator } from "#test/mocks/coverage-accumulator.ts";
import { block, NO_IGNORES, span } from "#test/mocks/coverage-spec-luau-ast.ts";
import { createStatementCollector } from "./collect-statements.ts";

describe(createStatementCollector, () => {
	it("should collect every instrumentable statement type and ignore metadata nodes", () => {
		expect.assertions(2);

		const accumulator = recordingAccumulator();
		const collector = createStatementCollector(accumulator, NO_IGNORES);
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

	it("should skip a statement the ignores cover", () => {
		expect.assertions(1);

		const accumulator = recordingAccumulator();
		const collector = createStatementCollector(accumulator, {
			...NO_IGNORES,
			covers: (location) => location.beginLine === 1,
		});

		collector.visitStatBlock!(
			block(9, [
				{ location: span(1), type: "AstStatExpr" },
				{ location: span(2), type: "AstStatExpr" },
			]),
		);

		expect(accumulator.result().statements).toStrictEqual([{ index: 1, location: span(2) }]);
	});
});
