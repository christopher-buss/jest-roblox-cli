import type {
	AstExpr,
	AstExprBinaryWithOperator,
	AstExprConstantBool,
	AstExprConstantNumber,
	AstExprFunction,
	AstExprGlobal,
	AstExprIfElse,
	AstExprIndexName,
	AstExprLocal,
	AstStatBlock,
	AstStatBreak,
	AstStatExpr,
	AstStatFunction,
	AstStatIf,
	AstStatLocal,
	AstStatLocalFunction,
	LuauSpan,
} from "@isentinel/luau-ast";

import { describe, expect, it } from "vitest";

import { collectCoverage } from "./coverage-collector.ts";

function span(
	beginLine: number,
	beginColumn: number,
	endLine: number,
	endColumn: number,
): LuauSpan {
	return { beginColumn, beginLine, endColumn, endLine };
}

function emptyBlock(location?: LuauSpan): AstStatBlock {
	return {
		kind: "stat",
		location: location ?? span(1, 1, 1, 1),
		statements: [],
		tag: "block",
	};
}

function globalExpr(name: string, location: LuauSpan): AstExprGlobal {
	return { name: { text: name }, kind: "expr", location, tag: "global" };
}

function localOf(value: AstExpr, location: LuauSpan): AstStatLocal {
	return { kind: "stat", location, tag: "local", values: [{ node: value }], variables: [] };
}

function rootOf(statement: AstStatLocal, location: LuauSpan): AstStatBlock {
	return { kind: "stat", location, statements: [statement], tag: "block" };
}

describe("coverage-collector", () => {
	describe(collectCoverage, () => {
		it("should return empty result for empty block", () => {
			expect.assertions(5);

			const result = collectCoverage(emptyBlock());

			expect(result.statements).toBeEmpty();
			expect(result.functions).toBeEmpty();
			expect(result.branches).toBeEmpty();
			expect(result.implicitElseProbes).toBeEmpty();
			expect(result.wrapProbes).toBeEmpty();
		});

		it("should collect instrumentable statements with 1-based indices", () => {
			expect.assertions(3);

			const stmt1 = {
				kind: "stat",
				location: span(1, 1, 1, 12),
				tag: "local",
				values: [],
				variables: [],
			} satisfies AstStatLocal;
			const stmt2 = {
				expression: {
					name: { text: "print" },
					kind: "expr",
					location: span(2, 1, 2, 9),
					tag: "global",
				} satisfies AstExprGlobal,
				kind: "stat",
				location: span(2, 1, 2, 9),
				tag: "expression",
			} satisfies AstStatExpr;
			const root = {
				kind: "stat",
				location: span(1, 1, 2, 9),
				statements: [stmt1, stmt2],
				tag: "block",
			} satisfies AstStatBlock;

			const result = collectCoverage(root);

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

		it("should collect named functions from localfunction statements", () => {
			expect.assertions(3);

			const bodyStatement = {
				kind: "stat",
				location: span(2, 5, 2, 20),
				tag: "break",
			} satisfies AstStatBreak;
			const body = {
				kind: "stat",
				location: span(1, 30, 3, 4),
				statements: [bodyStatement],
				tag: "block",
			} satisfies AstStatBlock;
			const func = {
				body,
				kind: "expr",
				location: span(1, 1, 3, 4),
				tag: "function",
			} satisfies AstExprFunction;
			const statement = {
				name: { name: { text: "greet" }, kind: "local", location: span(1, 16, 1, 21) },
				func,
				kind: "stat",
				location: span(1, 1, 3, 4),
				tag: "localfunction",
			} satisfies AstStatLocalFunction;
			const root = {
				kind: "stat",
				location: span(1, 1, 3, 4),
				statements: [statement],
				tag: "block",
			} satisfies AstStatBlock;

			const result = collectCoverage(root);

			expect(result.functions).toHaveLength(1);
			expect(result.functions[0]?.name).toBe("greet");
			expect(result.functions[0]).toStrictEqual({
				name: "greet",
				bodyFirstColumn: 5,
				bodyFirstLine: 2,
				index: 1,
				location: span(1, 1, 3, 4),
			});
		});

		it("should fall back to (anonymous) when function name expression is unrecognized", () => {
			expect.assertions(1);

			const body = {
				kind: "stat",
				location: span(1, 25, 3, 4),
				statements: [],
				tag: "block",
			} satisfies AstStatBlock;
			const nameExpr = {
				kind: "expr",
				location: span(1, 10, 1, 19),
				tag: "local",
				token: undefined,
			} satisfies AstExprLocal;
			const statement = {
				name: nameExpr,
				func: { body, kind: "expr", location: span(1, 1, 3, 4), tag: "function" },
				kind: "stat",
				location: span(1, 1, 3, 4),
				tag: "function",
			} satisfies AstStatFunction;
			const root = {
				kind: "stat",
				location: span(1, 1, 3, 4),
				statements: [statement],
				tag: "block",
			} satisfies AstStatBlock;

			const result = collectCoverage(root);

			expect(result.functions[0]?.name).toBe("(anonymous)");
		});

		it("should collect named functions from global function statements", () => {
			expect.assertions(2);

			const body = {
				kind: "stat",
				location: span(1, 25, 3, 4),
				statements: [
					{
						kind: "stat",
						location: span(2, 5, 2, 20),
						tag: "break",
					} satisfies AstStatBreak,
				],
				tag: "block",
			} satisfies AstStatBlock;
			const nameExpr = {
				name: { text: "globalFunc" },
				kind: "expr",
				location: span(1, 10, 1, 19),
				tag: "global",
			} satisfies AstExprGlobal;
			const statement = {
				name: nameExpr,
				func: { body, kind: "expr", location: span(1, 1, 3, 4), tag: "function" },
				kind: "stat",
				location: span(1, 1, 3, 4),
				tag: "function",
			} satisfies AstStatFunction;
			const root = {
				kind: "stat",
				location: span(1, 1, 3, 4),
				statements: [statement],
				tag: "block",
			} satisfies AstStatBlock;

			const result = collectCoverage(root);

			expect(result.functions).toHaveLength(1);
			expect(result.functions[0]?.name).toBe("globalFunc");
		});

		it("should collect anonymous function expressions in local assignments", () => {
			expect.assertions(2);

			const funcExpr = {
				body: {
					kind: "stat",
					location: span(1, 30, 3, 4),
					statements: [
						{
							kind: "stat",
							location: span(2, 5, 2, 15),
							tag: "break",
						} satisfies AstStatBreak,
					],
					tag: "block",
				},
				kind: "expr",
				location: span(1, 17, 3, 4),
				tag: "function",
			} satisfies AstExprFunction;
			const statement = {
				kind: "stat",
				location: span(1, 1, 3, 4),
				tag: "local",
				values: [{ node: funcExpr }],
				variables: [],
			} satisfies AstStatLocal;
			const root = {
				kind: "stat",
				location: span(1, 1, 3, 4),
				statements: [statement],
				tag: "block",
			} satisfies AstStatBlock;

			const result = collectCoverage(root);

			expect(result.functions).toHaveLength(1);
			expect(result.functions[0]?.name).toBe("(anonymous)");
		});

		it("should collect if-else branches with then, elseif, and else arms", () => {
			expect.assertions(5);

			const condition = {
				kind: "expr",
				location: span(3, 4, 3, 14),
				tag: "boolean",
				value: true,
			} satisfies AstExprConstantBool;
			const thenStatement = {
				kind: "stat",
				location: span(4, 5, 4, 17),
				tag: "break",
			} satisfies AstStatBreak;
			const thenBlock = {
				kind: "stat",
				location: span(3, 15, 5, 1),
				statements: [thenStatement],
				tag: "block",
			} satisfies AstStatBlock;
			const elseifStatement = {
				kind: "stat",
				location: span(6, 5, 6, 17),
				tag: "break",
			} satisfies AstStatBreak;
			const elseifBlock = {
				kind: "stat",
				location: span(5, 19, 7, 1),
				statements: [elseifStatement],
				tag: "block",
			} satisfies AstStatBlock;
			const elseStatement = {
				kind: "stat",
				location: span(8, 5, 8, 17),
				tag: "break",
			} satisfies AstStatBreak;
			const elseBlock = {
				kind: "stat",
				location: span(7, 5, 9, 1),
				statements: [elseStatement],
				tag: "block",
			} satisfies AstStatBlock;
			const ifStatement = {
				condition,
				elseBlock,
				elseifs: [
					{
						condition: {
							kind: "expr",
							location: span(5, 10, 5, 18),
							tag: "boolean",
							value: false,
						} satisfies AstExprConstantBool,
						thenBlock: elseifBlock,
					},
				],
				kind: "stat",
				location: span(3, 1, 9, 4),
				tag: "conditional",
				thenBlock,
			} satisfies AstStatIf;
			const root = {
				kind: "stat",
				location: span(1, 1, 9, 4),
				statements: [ifStatement],
				tag: "block",
			} satisfies AstStatBlock;

			const result = collectCoverage(root);

			expect(result.branches).toHaveLength(1);
			expect(result.branches[0]?.branchType).toBe("if");
			expect(result.branches[0]?.arms).toHaveLength(3);
			expect(result.branches[0]?.arms[0]?.bodyFirstLine).toBe(4);
			expect(result.implicitElseProbes).toBeEmpty();
		});

		it("should create implicit else probe for if without else", () => {
			expect.assertions(5);

			const thenStatement = {
				kind: "stat",
				location: span(2, 3, 2, 14),
				tag: "break",
			} satisfies AstStatBreak;
			const thenBlock = {
				kind: "stat",
				location: span(1, 13, 3, 1),
				statements: [thenStatement],
				tag: "block",
			} satisfies AstStatBlock;
			const ifStatement = {
				condition: {
					kind: "expr",
					location: span(1, 4, 1, 8),
					tag: "boolean",
					value: true,
				},
				elseifs: [],
				kind: "stat",
				location: span(1, 1, 3, 4),
				tag: "conditional",
				thenBlock,
			} satisfies AstStatIf;
			const root = {
				kind: "stat",
				location: span(1, 1, 3, 4),
				statements: [ifStatement],
				tag: "block",
			} satisfies AstStatBlock;

			const result = collectCoverage(root);

			expect(result.branches).toHaveLength(1);
			// then arm + implicit else arm
			expect(result.branches[0]?.arms).toHaveLength(2);
			expect(result.implicitElseProbes).toHaveLength(1);
			expect(result.implicitElseProbes[0]?.endLine).toBe(3);
			expect(result.implicitElseProbes[0]?.endColumn).toBe(1);
		});

		it("should place implicit else probe at start of `end` when source has trailing semicolon", () => {
			expect.assertions(2);

			// Models: `if true then\n    local x = 1\nend;`
			// Lute extends the if statement's location past the `;`:
			//   ifStatement.endColumn = 5 (past `;`), but `end` starts at col 1.
			// thenBlock.endColumn reliably marks the start of `end`.
			const thenStatement = {
				kind: "stat",
				location: span(2, 5, 2, 16),
				tag: "local",
				values: [],
				variables: [],
			} satisfies AstStatLocal;
			const thenBlock = {
				kind: "stat",
				location: span(1, 13, 3, 1),
				statements: [thenStatement],
				tag: "block",
			} satisfies AstStatBlock;
			const ifStatement = {
				condition: {
					kind: "expr",
					location: span(1, 4, 1, 8),
					tag: "boolean",
					value: true,
				},
				elseifs: [],
				kind: "stat",
				location: span(1, 1, 3, 5),
				tag: "conditional",
				thenBlock,
			} satisfies AstStatIf;
			const root = {
				kind: "stat",
				location: span(1, 1, 3, 5),
				statements: [ifStatement],
				tag: "block",
			} satisfies AstStatBlock;

			const result = collectCoverage(root);

			expect(result.implicitElseProbes[0]?.endLine).toBe(3);
			expect(result.implicitElseProbes[0]?.endColumn).toBe(1);
		});

		it("should place implicit else probe at start of `end` for if/elseif with trailing semicolon", () => {
			expect.assertions(2);

			// Models: `if true then\n    local x = 1\nelseif false then\n
			// local y = 2\nend;` ifStatement.endColumn = 5 (past `;`), last
			// elseif's thenBlock.endColumn = 1 (start of `end`).
			const thenBlock = {
				kind: "stat",
				location: span(1, 13, 3, 1),
				statements: [
					{
						kind: "stat",
						location: span(2, 5, 2, 16),
						tag: "local",
						values: [],
						variables: [],
					} satisfies AstStatLocal,
				],
				tag: "block",
			} satisfies AstStatBlock;
			const elseifBlock = {
				kind: "stat",
				location: span(3, 18, 5, 1),
				statements: [
					{
						kind: "stat",
						location: span(4, 5, 4, 16),
						tag: "local",
						values: [],
						variables: [],
					} satisfies AstStatLocal,
				],
				tag: "block",
			} satisfies AstStatBlock;
			const ifStatement = {
				condition: {
					kind: "expr",
					location: span(1, 4, 1, 8),
					tag: "boolean",
					value: true,
				},
				elseifs: [
					{
						condition: {
							kind: "expr",
							location: span(3, 8, 3, 13),
							tag: "boolean",
							value: false,
						} satisfies AstExprConstantBool,
						thenBlock: elseifBlock,
					},
				],
				kind: "stat",
				location: span(1, 1, 5, 5),
				tag: "conditional",
				thenBlock,
			} satisfies AstStatIf;
			const root = {
				kind: "stat",
				location: span(1, 1, 5, 5),
				statements: [ifStatement],
				tag: "block",
			} satisfies AstStatBlock;

			const result = collectCoverage(root);

			expect(result.implicitElseProbes[0]?.endLine).toBe(5);
			expect(result.implicitElseProbes[0]?.endColumn).toBe(1);
		});

		it("should collect expr-if branches with bodyFirstLine=0", () => {
			expect.assertions(5);

			const exprIf = {
				condition: {
					kind: "expr",
					location: span(1, 13, 1, 17),
					tag: "boolean",
					value: true,
				},
				elseExpr: {
					kind: "expr",
					location: span(1, 31, 1, 32),
					tag: "number",
					value: 2,
				} satisfies AstExprConstantNumber,
				elseifs: [],
				kind: "expr",
				location: span(1, 9, 1, 32),
				tag: "conditional",
				thenExpr: {
					kind: "expr",
					location: span(1, 24, 1, 25),
					tag: "number",
					value: 1,
				} satisfies AstExprConstantNumber,
			} satisfies AstExprIfElse;
			const statement = {
				kind: "stat",
				location: span(1, 1, 1, 32),
				tag: "local",
				values: [{ node: exprIf }],
				variables: [],
			} satisfies AstStatLocal;
			const root = {
				kind: "stat",
				location: span(1, 1, 1, 32),
				statements: [statement],
				tag: "block",
			} satisfies AstStatBlock;

			const result = collectCoverage(root);

			expect(result.branches).toHaveLength(1);
			expect(result.branches[0]?.branchType).toBe("expr-if");
			expect(result.branches[0]?.arms).toHaveLength(2);
			expect(result.branches[0]?.arms[0]?.bodyFirstLine).toBe(0);
			expect(result.branches[0]?.arms[1]?.bodyFirstLine).toBe(0);
		});

		it("should generate wrapProbes for each expr-if arm", () => {
			expect.assertions(3);

			const exprIf = {
				condition: {
					kind: "expr",
					location: span(1, 13, 1, 17),
					tag: "boolean",
					value: true,
				},
				elseExpr: {
					kind: "expr",
					location: span(1, 31, 1, 32),
					tag: "number",
					value: 2,
				} satisfies AstExprConstantNumber,
				elseifs: [],
				kind: "expr",
				location: span(1, 9, 1, 32),
				tag: "conditional",
				thenExpr: {
					kind: "expr",
					location: span(1, 24, 1, 25),
					tag: "number",
					value: 1,
				} satisfies AstExprConstantNumber,
			} satisfies AstExprIfElse;
			const statement = {
				kind: "stat",
				location: span(1, 1, 1, 32),
				tag: "local",
				values: [{ node: exprIf }],
				variables: [],
			} satisfies AstStatLocal;
			const root = {
				kind: "stat",
				location: span(1, 1, 1, 32),
				statements: [statement],
				tag: "block",
			} satisfies AstStatBlock;

			const result = collectCoverage(root);

			expect(result.wrapProbes).toHaveLength(2);
			expect(result.wrapProbes[0]).toStrictEqual({
				armIndex: 1,
				branchIndex: 1,
				exprLocation: span(1, 24, 1, 25),
			});
			expect(result.wrapProbes[1]).toStrictEqual({
				armIndex: 2,
				branchIndex: 1,
				exprLocation: span(1, 31, 1, 32),
			});
		});

		it("should extract dotted name from dot-method function", () => {
			expect.assertions(2);

			const nameExpr = {
				accessor: { text: "." },
				expression: {
					name: { text: "Obj" },
					kind: "expr",
					location: span(1, 10, 1, 13),
					tag: "global",
				} satisfies AstExprGlobal,
				index: { text: "method" },
				kind: "expr",
				location: span(1, 10, 1, 20),
				tag: "indexname",
			} satisfies AstExprIndexName;
			const statement = {
				name: nameExpr,
				func: {
					body: emptyBlock(),
					kind: "expr",
					location: span(1, 1, 3, 4),
					tag: "function",
				},
				kind: "stat",
				location: span(1, 1, 3, 4),
				tag: "function",
			} satisfies AstStatFunction;
			const root = {
				kind: "stat",
				location: span(1, 1, 3, 4),
				statements: [statement],
				tag: "block",
			} satisfies AstStatBlock;

			const result = collectCoverage(root);

			expect(result.functions).toHaveLength(1);
			expect(result.functions[0]?.name).toBe("Obj.method");
		});

		it("should extract colon name from colon-method function", () => {
			expect.assertions(2);

			const nameExpr = {
				accessor: { text: ":" },
				expression: {
					name: { text: "Obj" },
					kind: "expr",
					location: span(1, 10, 1, 13),
					tag: "global",
				} satisfies AstExprGlobal,
				index: { text: "method" },
				kind: "expr",
				location: span(1, 10, 1, 20),
				tag: "indexname",
			} satisfies AstExprIndexName;
			const statement = {
				name: nameExpr,
				func: {
					body: emptyBlock(),
					kind: "expr",
					location: span(1, 1, 3, 4),
					tag: "function",
				},
				kind: "stat",
				location: span(1, 1, 3, 4),
				tag: "function",
			} satisfies AstStatFunction;
			const root = {
				kind: "stat",
				location: span(1, 1, 3, 4),
				statements: [statement],
				tag: "block",
			} satisfies AstStatBlock;

			const result = collectCoverage(root);

			expect(result.functions).toHaveLength(1);
			expect(result.functions[0]?.name).toBe("Obj:method");
		});

		it("should use body block start position for empty-body function", () => {
			expect.assertions(3);

			const statement = {
				name: { name: { text: "noop" }, kind: "local", location: span(1, 16, 1, 20) },
				func: {
					body: emptyBlock(span(1, 25, 3, 4)),
					kind: "expr",
					location: span(1, 1, 3, 4),
					tag: "function",
				},
				kind: "stat",
				location: span(1, 1, 3, 4),
				tag: "localfunction",
			} satisfies AstStatLocalFunction;
			const root = {
				kind: "stat",
				location: span(1, 1, 3, 4),
				statements: [statement],
				tag: "block",
			} satisfies AstStatBlock;

			const result = collectCoverage(root);

			expect(result.functions).toHaveLength(1);
			expect(result.functions[0]?.bodyFirstLine).toBe(1);
			expect(result.functions[0]?.bodyFirstColumn).toBe(25);
		});

		it("should collect expr-if with elseif arms", () => {
			expect.assertions(5);

			const exprIf = {
				condition: {
					kind: "expr",
					location: span(1, 13, 1, 18),
					tag: "boolean",
					value: false,
				},
				elseExpr: {
					kind: "expr",
					location: span(1, 55, 1, 58),
					tag: "string",
					text: "c",
				},
				elseifs: [
					{
						condition: {
							kind: "expr",
							location: span(1, 30, 1, 34),
							tag: "boolean",
							value: true,
						} satisfies AstExprConstantBool,
						thenExpr: {
							kind: "expr",
							location: span(1, 40, 1, 43),
							tag: "string",
							text: "b",
						},
					},
				],
				kind: "expr",
				location: span(1, 9, 1, 58),
				tag: "conditional",
				thenExpr: {
					kind: "expr",
					location: span(1, 24, 1, 27),
					tag: "string",
					text: "a",
				},
			} satisfies AstExprIfElse;
			const statement = {
				kind: "stat",
				location: span(1, 1, 1, 58),
				tag: "local",
				values: [{ node: exprIf }],
				variables: [],
			} satisfies AstStatLocal;
			const root = {
				kind: "stat",
				location: span(1, 1, 1, 58),
				statements: [statement],
				tag: "block",
			} satisfies AstStatBlock;

			const result = collectCoverage(root);

			expect(result.branches).toHaveLength(1);
			expect(result.branches[0]?.branchType).toBe("expr-if");
			// 3 arms: then + elseif-then + else
			expect(result.branches[0]?.arms).toHaveLength(3);
			// 3 wrap probes: one per arm
			expect(result.wrapProbes).toHaveLength(3);
			expect(result.wrapProbes.map((probe) => probe.armIndex)).toStrictEqual([1, 2, 3]);
		});

		it("should skip non-instrumentable statement tags", () => {
			expect.assertions(1);

			const root = {
				kind: "stat",
				location: span(1, 1, 1, 20),
				statements: [{ kind: "stat", location: span(1, 1, 1, 20), tag: "typealias" }],
				tag: "block",
			} satisfies AstStatBlock;

			const result = collectCoverage(root);

			expect(result.statements).toBeEmpty();
		});

		it("should collect an and expression as a binary-expr branch", () => {
			expect.assertions(5);

			const binary = {
				kind: "expr",
				lhsOperand: globalExpr("a", span(1, 11, 1, 12)),
				location: span(1, 11, 1, 18),
				operator: { location: span(1, 13, 1, 16), text: "and" },
				rhsOperand: globalExpr("b", span(1, 17, 1, 18)),
				tag: "binary",
			} satisfies AstExprBinaryWithOperator;
			const root = rootOf(localOf(binary, span(1, 1, 1, 18)), span(1, 1, 1, 18));

			const result = collectCoverage(root);

			expect(result.branches).toHaveLength(1);
			expect(result.branches[0]?.branchType).toBe("binary-expr");
			expect(result.branches[0]?.arms).toHaveLength(2);
			expect(result.branches[0]?.arms.map((arm) => arm.location)).toStrictEqual([
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

			const binary = {
				kind: "expr",
				lhsOperand: globalExpr("p", span(1, 11, 1, 12)),
				location: span(1, 11, 1, 17),
				operator: { location: span(1, 13, 1, 15), text: "or" },
				rhsOperand: globalExpr("q", span(1, 16, 1, 17)),
				tag: "binary",
			} satisfies AstExprBinaryWithOperator;
			const root = rootOf(localOf(binary, span(1, 1, 1, 17)), span(1, 1, 1, 17));

			const result = collectCoverage(root);

			expect(result.branches[0]?.branchType).toBe("binary-expr");
			expect(result.wrapProbes).toHaveLength(2);
		});

		it("should not treat a non-logical binary operator as a branch", () => {
			expect.assertions(2);

			const binary = {
				kind: "expr",
				lhsOperand: globalExpr("a", span(1, 11, 1, 12)),
				location: span(1, 11, 1, 16),
				operator: { location: span(1, 13, 1, 14), text: "+" },
				rhsOperand: globalExpr("b", span(1, 15, 1, 16)),
				tag: "binary",
			} satisfies AstExprBinaryWithOperator;
			const root = rootOf(localOf(binary, span(1, 1, 1, 16)), span(1, 1, 1, 16));

			const result = collectCoverage(root);

			expect(result.branches).toBeEmpty();
			expect(result.wrapProbes).toBeEmpty();
		});

		it("should collect a left-associative and chain as two nested branches", () => {
			expect.assertions(3);

			// `a and b and c` parses as `(a and b) and c`. The outer node is
			// visited first (branch 1, arms = `a and b` and `c`), then the
			// inner (branch 2, arms = `a` and `b`).
			const inner = {
				kind: "expr",
				lhsOperand: globalExpr("a", span(1, 11, 1, 12)),
				location: span(1, 11, 1, 18),
				operator: { location: span(1, 13, 1, 16), text: "and" },
				rhsOperand: globalExpr("b", span(1, 17, 1, 18)),
				tag: "binary",
			} satisfies AstExprBinaryWithOperator;
			const outer = {
				kind: "expr",
				lhsOperand: inner,
				location: span(1, 11, 1, 25),
				operator: { location: span(1, 19, 1, 22), text: "and" },
				rhsOperand: globalExpr("c", span(1, 24, 1, 25)),
				tag: "binary",
			} satisfies AstExprBinaryWithOperator;
			const root = rootOf(localOf(outer, span(1, 1, 1, 25)), span(1, 1, 1, 25));

			const result = collectCoverage(root);

			expect(result.branches.map((branch) => branch.index)).toStrictEqual([1, 2]);
			expect(result.branches[0]?.arms.map((arm) => arm.location)).toStrictEqual([
				span(1, 11, 1, 18),
				span(1, 24, 1, 25),
			]);
			expect(result.branches[1]?.arms.map((arm) => arm.location)).toStrictEqual([
				span(1, 11, 1, 12),
				span(1, 17, 1, 18),
			]);
		});
	});
});
