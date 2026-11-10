import type {
	AstExprFunction,
	AstStatFunction,
	AstStatLocalFunction,
} from "@isentinel/luau-ast/ast";
import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it } from "vitest";

import { recordingAccumulator } from "#test/mocks/coverage-accumulator.ts";
import { block, NO_IGNORES, span } from "#test/mocks/coverage-spec-luau-ast.ts";
import { createFunctionCollector, getBodyFirstStatement } from "./collect-functions.ts";

function expressionAt(line: number): AstExprFunction {
	return fromAny<AstExprFunction, unknown>({
		body: block(line + 1),
		location: span(line),
		type: "AstExprFunction",
	});
}

describe(createFunctionCollector, () => {
	it("should name functions, preserve traversal, and avoid counting named expressions twice", () => {
		expect.assertions(2);

		const accumulator = recordingAccumulator();
		const collector = createFunctionCollector(accumulator, NO_IGNORES);
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

	it("should name an index on a non-name target from an anonymous base", () => {
		expect.assertions(1);

		const accumulator = recordingAccumulator();
		const collector = createFunctionCollector(accumulator, NO_IGNORES);

		collector.visitStatFunction!(
			fromAny<AstStatFunction, unknown>({
				name: {
					expr: { type: "AstExprCall" },
					index: "run",
					op: ":",
					type: "AstExprIndexName",
				},
				func: expressionAt(2),
				location: span(1),
				type: "AstStatFunction",
			}),
		);

		expect(accumulator.result().functions.map(({ name }) => name)).toStrictEqual([
			"(anonymous):run",
		]);
	});

	it("should skip functions the ignores cover", () => {
		expect.assertions(2);

		const accumulator = recordingAccumulator();
		const collector = createFunctionCollector(accumulator, {
			...NO_IGNORES,
			covers: () => true,
		});

		expect([
			collector.visitStatLocalFunction!(
				fromAny<AstStatLocalFunction, unknown>({
					name: { name: "helper" },
					func: expressionAt(2),
					location: span(1),
					type: "AstStatLocalFunction",
				}),
			),
			collector.visitExprFunction!(expressionAt(5)),
		]).toStrictEqual([true, true]);
		expect(accumulator.result().functions).toStrictEqual([]);
	});
});

describe(getBodyFirstStatement, () => {
	it("should use the block position for an empty function body", () => {
		expect.assertions(1);

		expect(getBodyFirstStatement(block(42))).toStrictEqual({ column: 1, line: 42 });
	});

	it("should use the position of the first statement for a non-empty body", () => {
		expect.assertions(1);

		expect(
			getBodyFirstStatement(
				block(42, [{ location: { ...span(43), beginColumn: 3 }, type: "AstStatReturn" }]),
			),
		).toStrictEqual({ column: 3, line: 43 });
	});
});
