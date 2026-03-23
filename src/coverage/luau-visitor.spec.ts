import { describe, expect, it, vi } from "vitest";

import type {
	AstExpr,
	AstExprBinary,
	AstExprCall,
	AstExprConstantBool,
	AstExprConstantNil,
	AstExprConstantNumber,
	AstExprConstantString,
	AstExprFunction,
	AstExprGlobal,
	AstExprGroup,
	AstExprIfElse,
	AstExprIndexExpr,
	AstExprIndexName,
	AstExprInstantiate,
	AstExprInterpString,
	AstExprLocal,
	AstExprTable,
	AstExprTypeAssertion,
	AstExprUnary,
	AstExprVarargs,
	AstStat,
	AstStatAssign,
	AstStatBlock,
	AstStatBreak,
	AstStatCompoundAssign,
	AstStatContinue,
	AstStatDo,
	AstStatExpr,
	AstStatFor,
	AstStatForIn,
	AstStatFunction,
	AstStatIf,
	AstStatLocal,
	AstStatLocalFunction,
	AstStatRepeat,
	AstStatReturn,
	AstStatTypeAlias,
	AstStatTypeFunction,
	AstStatWhile,
	LuauSpan,
} from "../types/luau-ast.ts";
import type { LuauVisitor } from "./luau-visitor.ts";
import { visitBlock, visitExpression, visitStatement } from "./luau-visitor.ts";

const span: LuauSpan = { begincolumn: 1, beginline: 1, endcolumn: 1, endline: 1 };

function emptyBlock(): AstStatBlock {
	return { kind: "stat", location: span, statements: [], tag: "block" };
}

const breakNode = {
	kind: "stat",
	location: span,
	tag: "break",
} satisfies AstStatBreak;
const continueNode = {
	kind: "stat",
	location: span,
	tag: "continue",
} satisfies AstStatContinue;
const boolTrue = {
	kind: "expr",
	location: span,
	tag: "boolean",
	value: true,
} satisfies AstExprConstantBool;
const boolFalse = {
	kind: "expr",
	location: span,
	tag: "boolean",
	value: false,
} satisfies AstExprConstantBool;
const numberOne = {
	kind: "expr",
	location: span,
	tag: "number",
	value: 1,
} satisfies AstExprConstantNumber;

describe("luau-visitor", () => {
	describe(visitBlock, () => {
		it("should call visitStatBlock and visitStatBlockEnd", () => {
			expect.assertions(2);

			const visitor = {
				visitStatBlock: vi.fn<(node: AstStatBlock) => boolean>(() => true),
				visitStatBlockEnd: vi.fn<(node: AstStatBlock) => void>(),
			} satisfies LuauVisitor;
			const block = emptyBlock();

			visitBlock(block, visitor);

			expect(visitor.visitStatBlock).toHaveBeenCalledWith(block);
			expect(visitor.visitStatBlockEnd).toHaveBeenCalledWith(block);
		});

		it("should skip children when visitStatBlock returns false", () => {
			expect.assertions(2);

			const visitor = {
				visitStatBlock: vi.fn<(node: AstStatBlock) => boolean>(() => false),
				visitStatBlockEnd: vi.fn<(node: AstStatBlock) => void>(),
				visitStatBreak: vi.fn<(node: AstStatBreak) => boolean>(() => true),
			} satisfies LuauVisitor;
			const block = {
				kind: "stat",
				location: span,
				statements: [breakNode],
				tag: "block",
			} satisfies AstStatBlock;

			visitBlock(block, visitor);

			expect(visitor.visitStatBreak).not.toHaveBeenCalled();
			expect(visitor.visitStatBlockEnd).not.toHaveBeenCalled();
		});
	});

	describe(visitStatement, () => {
		it("should dispatch break statement to visitStatBreak", () => {
			expect.assertions(1);

			const visitor = {
				visitStatBreak: vi.fn<(node: AstStatBreak) => boolean>(() => true),
			} satisfies LuauVisitor;

			visitStatement(breakNode, visitor);

			expect(visitor.visitStatBreak).toHaveBeenCalledWith(breakNode);
		});

		it("should dispatch continue statement to visitStatContinue", () => {
			expect.assertions(1);

			const visitor = {
				visitStatContinue: vi.fn<(node: AstStatContinue) => boolean>(() => true),
			} satisfies LuauVisitor;
			visitStatement(continueNode, visitor);

			expect(visitor.visitStatContinue).toHaveBeenCalledWith(continueNode);
		});

		it("should dispatch do statement and recurse into body", () => {
			expect.assertions(2);

			const body = {
				kind: "stat",
				location: span,
				statements: [breakNode],
				tag: "block",
			} satisfies AstStatBlock;
			const node = { body, kind: "stat", location: span, tag: "do" } satisfies AstStatDo;
			const visitor = {
				visitStatBreak: vi.fn<(node: AstStatBreak) => boolean>(() => true),
				visitStatDo: vi.fn<(node: AstStatDo) => boolean>(() => true),
			} satisfies LuauVisitor;

			visitStatement(node, visitor);

			expect(visitor.visitStatDo).toHaveBeenCalledWith(node);
			expect(visitor.visitStatBreak).toHaveBeenCalledWith(breakNode);
		});

		it("should dispatch if statement with condition, thenblock, elseifs, and elseblock", () => {
			expect.assertions(4);

			const thenblock = {
				kind: "stat",
				location: span,
				statements: [breakNode],
				tag: "block",
			} satisfies AstStatBlock;
			const elseifBlock = {
				kind: "stat",
				location: span,
				statements: [],
				tag: "block",
			} satisfies AstStatBlock;
			const elseblock = {
				kind: "stat",
				location: span,
				statements: [continueNode],
				tag: "block",
			} satisfies AstStatBlock;
			const node = {
				condition: boolTrue,
				elseblock,
				elseifs: [{ condition: boolFalse, thenblock: elseifBlock }],
				kind: "stat",
				location: span,
				tag: "conditional",
				thenblock,
			} satisfies AstStatIf;
			const visitor = {
				visitExprConstantBool: vi.fn<(node: AstExprConstantBool) => boolean>(() => true),
				visitStatBreak: vi.fn<(node: AstStatBreak) => boolean>(() => true),
				visitStatContinue: vi.fn<(node: AstStatContinue) => boolean>(() => true),
				visitStatIf: vi.fn<(node: AstStatIf) => boolean>(() => true),
			} satisfies LuauVisitor;

			visitStatement(node, visitor);

			expect(visitor.visitStatIf).toHaveBeenCalledWith(node);
			expect(visitor.visitStatBreak).toHaveBeenCalledWith(breakNode);
			expect(visitor.visitStatContinue).toHaveBeenCalledWith(continueNode);
			expect(visitor.visitExprConstantBool).toHaveBeenCalledTimes(2);
		});

		it("should dispatch while statement with condition and body", () => {
			expect.assertions(2);

			const body = {
				kind: "stat",
				location: span,
				statements: [breakNode],
				tag: "block",
			} satisfies AstStatBlock;
			const node = {
				body,
				condition: boolTrue,
				kind: "stat",
				location: span,
				tag: "while",
			} satisfies AstStatWhile;
			const visitor = {
				visitStatBreak: vi.fn<(node: AstStatBreak) => boolean>(() => true),
				visitStatWhile: vi.fn<(node: AstStatWhile) => boolean>(() => true),
			} satisfies LuauVisitor;

			visitStatement(node, visitor);

			expect(visitor.visitStatWhile).toHaveBeenCalledWith(node);
			expect(visitor.visitStatBreak).toHaveBeenCalledWith(breakNode);
		});

		it("should dispatch repeat statement with body and condition", () => {
			expect.assertions(3);

			const body = {
				kind: "stat",
				location: span,
				statements: [breakNode],
				tag: "block",
			} satisfies AstStatBlock;
			const node = {
				body,
				condition: boolTrue,
				kind: "stat",
				location: span,
				tag: "repeat",
			} satisfies AstStatRepeat;
			const visitor = {
				visitExprConstantBool: vi.fn<(node: AstExprConstantBool) => boolean>(() => true),
				visitStatBreak: vi.fn<(node: AstStatBreak) => boolean>(() => true),
				visitStatRepeat: vi.fn<(node: AstStatRepeat) => boolean>(() => true),
			} satisfies LuauVisitor;

			visitStatement(node, visitor);

			expect(visitor.visitStatRepeat).toHaveBeenCalledWith(node);
			expect(visitor.visitStatBreak).toHaveBeenCalledWith(breakNode);
			expect(visitor.visitExprConstantBool).toHaveBeenCalledWith(boolTrue);
		});

		it("should dispatch for statement and recurse into from, to, and body", () => {
			expect.assertions(4);

			const toExpr = {
				kind: "expr",
				location: span,
				tag: "number",
				value: 10,
			} satisfies AstExprConstantNumber;
			const body = {
				kind: "stat",
				location: span,
				statements: [breakNode],
				tag: "block",
			} satisfies AstStatBlock;
			const node = {
				body,
				from: numberOne,
				kind: "stat",
				location: span,
				tag: "for",
				to: toExpr,
			} satisfies AstStatFor;
			const visitor = {
				visitExprConstantNumber: vi.fn<(node: AstExprConstantNumber) => boolean>(
					() => true,
				),
				visitStatBreak: vi.fn<(node: AstStatBreak) => boolean>(() => true),
				visitStatFor: vi.fn<(node: AstStatFor) => boolean>(() => true),
			} satisfies LuauVisitor;

			visitStatement(node, visitor);

			expect(visitor.visitStatFor).toHaveBeenCalledWith(node);
			expect(visitor.visitExprConstantNumber).toHaveBeenCalledWith(numberOne);
			expect(visitor.visitExprConstantNumber).toHaveBeenCalledWith(toExpr);
			expect(visitor.visitStatBreak).toHaveBeenCalledWith(breakNode);
		});

		it("should recurse into step expression when present on for statement", () => {
			expect.assertions(2);

			const toExpr = {
				kind: "expr",
				location: span,
				tag: "number",
				value: 10,
			} satisfies AstExprConstantNumber;
			const stepExpr = {
				kind: "expr",
				location: span,
				tag: "number",
				value: 2,
			} satisfies AstExprConstantNumber;
			const node = {
				body: emptyBlock(),
				from: numberOne,
				kind: "stat",
				location: span,
				step: stepExpr,
				tag: "for",
				to: toExpr,
			} satisfies AstStatFor;
			const visitor = {
				visitExprConstantNumber: vi.fn<(node: AstExprConstantNumber) => boolean>(
					() => true,
				),
				visitStatFor: vi.fn<(node: AstStatFor) => boolean>(() => true),
			} satisfies LuauVisitor;

			visitStatement(node, visitor);

			expect(visitor.visitStatFor).toHaveBeenCalledWith(node);
			expect(visitor.visitExprConstantNumber).toHaveBeenCalledWith(stepExpr);
		});

		it("should dispatch forin statement with values and body", () => {
			expect.assertions(3);

			const valueExpr = {
				kind: "expr",
				location: span,
				tag: "number",
				value: 42,
			} satisfies AstExprConstantNumber;
			const body = {
				kind: "stat",
				location: span,
				statements: [breakNode],
				tag: "block",
			} satisfies AstStatBlock;
			const node = {
				body,
				kind: "stat",
				location: span,
				tag: "forin",
				values: [{ node: valueExpr }],
			} satisfies AstStatForIn;
			const visitor = {
				visitExprConstantNumber: vi.fn<(node: AstExprConstantNumber) => boolean>(
					() => true,
				),
				visitStatBreak: vi.fn<(node: AstStatBreak) => boolean>(() => true),
				visitStatForIn: vi.fn<(node: AstStatForIn) => boolean>(() => true),
			} satisfies LuauVisitor;

			visitStatement(node, visitor);

			expect(visitor.visitStatForIn).toHaveBeenCalledWith(node);
			expect(visitor.visitExprConstantNumber).toHaveBeenCalledWith(valueExpr);
			expect(visitor.visitStatBreak).toHaveBeenCalledWith(breakNode);
		});

		it("should dispatch local statement and recurse into values", () => {
			expect.assertions(2);

			const node = {
				kind: "stat",
				location: span,
				tag: "local",
				values: [{ node: numberOne }],
				variables: [],
			} satisfies AstStatLocal;
			const visitor = {
				visitExprConstantNumber: vi.fn<(node: AstExprConstantNumber) => boolean>(
					() => true,
				),
				visitStatLocal: vi.fn<(node: AstStatLocal) => boolean>(() => true),
			} satisfies LuauVisitor;

			visitStatement(node, visitor);

			expect(visitor.visitStatLocal).toHaveBeenCalledWith(node);
			expect(visitor.visitExprConstantNumber).toHaveBeenCalledWith(numberOne);
		});

		it("should dispatch assign statement and recurse into variables and values", () => {
			expect.assertions(3);

			const lhs = {
				name: { text: "x" },
				kind: "expr",
				location: span,
				tag: "global",
			} satisfies AstExprGlobal;
			const rhs = {
				kind: "expr",
				location: span,
				tag: "number",
				value: 42,
			} satisfies AstExprConstantNumber;
			const node = {
				kind: "stat",
				location: span,
				tag: "assign",
				values: [{ node: rhs }],
				variables: [{ node: lhs }],
			} satisfies AstStatAssign;
			const visitor = {
				visitExprConstantNumber: vi.fn<(node: AstExprConstantNumber) => boolean>(
					() => true,
				),
				visitExprGlobal: vi.fn<(node: AstExprGlobal) => boolean>(() => true),
				visitStatAssign: vi.fn<(node: AstStatAssign) => boolean>(() => true),
			} satisfies LuauVisitor;

			visitStatement(node, visitor);

			expect(visitor.visitStatAssign).toHaveBeenCalledWith(node);
			expect(visitor.visitExprGlobal).toHaveBeenCalledWith(lhs);
			expect(visitor.visitExprConstantNumber).toHaveBeenCalledWith(rhs);
		});

		it("should dispatch compoundassign statement and recurse into variable and value", () => {
			expect.assertions(2);

			const variable = {
				name: { text: "x" },
				kind: "expr",
				location: span,
				tag: "global",
			} satisfies AstExprGlobal;
			const node = {
				kind: "stat",
				location: span,
				tag: "compoundassign",
				value: numberOne,
				variable,
			} satisfies AstStatCompoundAssign;
			const visitor = {
				visitExprConstantNumber: vi.fn<(node: AstExprConstantNumber) => boolean>(
					() => true,
				),
				visitStatCompoundAssign: vi.fn<(node: AstStatCompoundAssign) => boolean>(
					() => true,
				),
			} satisfies LuauVisitor;

			visitStatement(node, visitor);

			expect(visitor.visitStatCompoundAssign).toHaveBeenCalledWith(node);
			expect(visitor.visitExprConstantNumber).toHaveBeenCalledWith(numberOne);
		});

		it("should dispatch return statement and recurse into expressions", () => {
			expect.assertions(2);

			const node = {
				expressions: [{ node: numberOne }],
				kind: "stat",
				location: span,
				tag: "return",
			} satisfies AstStatReturn;
			const visitor = {
				visitExprConstantNumber: vi.fn<(node: AstExprConstantNumber) => boolean>(
					() => true,
				),
				visitStatReturn: vi.fn<(node: AstStatReturn) => boolean>(() => true),
			} satisfies LuauVisitor;

			visitStatement(node, visitor);

			expect(visitor.visitStatReturn).toHaveBeenCalledWith(node);
			expect(visitor.visitExprConstantNumber).toHaveBeenCalledWith(numberOne);
		});

		it("should dispatch expression statement and recurse into expression", () => {
			expect.assertions(2);

			const expr = {
				name: { text: "print" },
				kind: "expr",
				location: span,
				tag: "global",
			} satisfies AstExprGlobal;
			const node = {
				expression: expr,
				kind: "stat",
				location: span,
				tag: "expression",
			} satisfies AstStatExpr;
			const visitor = {
				visitExprGlobal: vi.fn<(node: AstExprGlobal) => boolean>(() => true),
				visitStatExpr: vi.fn<(node: AstStatExpr) => boolean>(() => true),
			} satisfies LuauVisitor;

			visitStatement(node, visitor);

			expect(visitor.visitStatExpr).toHaveBeenCalledWith(node);
			expect(visitor.visitExprGlobal).toHaveBeenCalledWith(expr);
		});

		it("should dispatch function statement and recurse into name and func body", () => {
			expect.assertions(3);

			const name = {
				name: { text: "foo" },
				kind: "expr",
				location: span,
				tag: "global",
			} satisfies AstExprGlobal;
			const body = {
				kind: "stat",
				location: span,
				statements: [breakNode],
				tag: "block",
			} satisfies AstStatBlock;
			const func = {
				body,
				kind: "expr",
				location: span,
				tag: "function",
			} satisfies AstExprFunction;
			const node = {
				name,
				func,
				kind: "stat",
				location: span,
				tag: "function",
			} satisfies AstStatFunction;
			const visitor = {
				visitExprGlobal: vi.fn<(node: AstExprGlobal) => boolean>(() => true),
				visitStatBreak: vi.fn<(node: AstStatBreak) => boolean>(() => true),
				visitStatFunction: vi.fn<(node: AstStatFunction) => boolean>(() => true),
			} satisfies LuauVisitor;

			visitStatement(node, visitor);

			expect(visitor.visitStatFunction).toHaveBeenCalledWith(node);
			expect(visitor.visitExprGlobal).toHaveBeenCalledWith(name);
			expect(visitor.visitStatBreak).toHaveBeenCalledWith(breakNode);
		});

		it("should dispatch localfunction statement and recurse into func body", () => {
			expect.assertions(2);

			const body = {
				kind: "stat",
				location: span,
				statements: [breakNode],
				tag: "block",
			} satisfies AstStatBlock;
			const func = {
				body,
				kind: "expr",
				location: span,
				tag: "function",
			} satisfies AstExprFunction;
			const node = {
				name: { name: { text: "bar" }, kind: "local", location: span },
				func,
				kind: "stat",
				location: span,
				tag: "localfunction",
			} satisfies AstStatLocalFunction;
			const visitor = {
				visitStatBreak: vi.fn<(node: AstStatBreak) => boolean>(() => true),
				visitStatLocalFunction: vi.fn<(node: AstStatLocalFunction) => boolean>(() => true),
			} satisfies LuauVisitor;

			visitStatement(node, visitor);

			expect(visitor.visitStatLocalFunction).toHaveBeenCalledWith(node);
			expect(visitor.visitStatBreak).toHaveBeenCalledWith(breakNode);
		});

		it("should dispatch typealias statement", () => {
			expect.assertions(1);

			const node = {
				kind: "stat",
				location: span,
				tag: "typealias",
			} satisfies AstStatTypeAlias;
			const visitor = {
				visitStatTypeAlias: vi.fn<(node: AstStatTypeAlias) => boolean>(() => true),
			} satisfies LuauVisitor;

			visitStatement(node, visitor);

			expect(visitor.visitStatTypeAlias).toHaveBeenCalledWith(node);
		});

		it("should dispatch typefunction statement", () => {
			expect.assertions(1);

			const node = {
				kind: "stat",
				location: span,
				tag: "typefunction",
			} satisfies AstStatTypeFunction;
			const visitor = {
				visitStatTypeFunction: vi.fn<(node: AstStatTypeFunction) => boolean>(() => true),
			} satisfies LuauVisitor;

			visitStatement(node, visitor);

			expect(visitor.visitStatTypeFunction).toHaveBeenCalledWith(node);
		});

		it("should silently skip unknown statement tags", () => {
			expect.assertions(1);

			const node = { kind: "stat", location: span, tag: "unknown" } as unknown as AstStat;

			expect(() => {
				visitStatement(node, {});
			}).not.toThrow();
		});
	});

	describe(visitExpression, () => {
		it("should call visitExpr and visitExprEnd as pre/post hooks", () => {
			expect.assertions(2);

			const visitor = {
				visitExpr: vi.fn<(node: AstExpr) => boolean>(() => true),
				visitExprEnd: vi.fn<(node: AstExpr) => void>(),
			} satisfies LuauVisitor;

			visitExpression(numberOne, visitor);

			expect(visitor.visitExpr).toHaveBeenCalledWith(numberOne);
			expect(visitor.visitExprEnd).toHaveBeenCalledWith(numberOne);
		});

		it("should skip tag-specific dispatch when visitExpr returns false", () => {
			expect.assertions(2);

			const visitor = {
				visitExpr: vi.fn<(node: AstExpr) => boolean>(() => false),
				visitExprConstantNumber: vi.fn<(node: AstExprConstantNumber) => boolean>(
					() => true,
				),
				visitExprEnd: vi.fn<(node: AstExpr) => void>(),
			} satisfies LuauVisitor;

			visitExpression(numberOne, visitor);

			expect(visitor.visitExprConstantNumber).not.toHaveBeenCalled();
			expect(visitor.visitExprEnd).not.toHaveBeenCalled();
		});

		it("should dispatch call expression and recurse into func and arguments", () => {
			expect.assertions(3);

			const funcExpr = {
				name: { text: "print" },
				kind: "expr",
				location: span,
				tag: "global",
			} satisfies AstExprGlobal;
			const argument = {
				kind: "expr",
				location: span,
				tag: "number",
				value: 42,
			} satisfies AstExprConstantNumber;
			const node = {
				arguments: [{ node: argument }],
				func: funcExpr,
				kind: "expr",
				location: span,
				tag: "call",
			} satisfies AstExprCall;
			const visitor = {
				visitExprCall: vi.fn<(node: AstExprCall) => boolean>(() => true),
				visitExprConstantNumber: vi.fn<(node: AstExprConstantNumber) => boolean>(
					() => true,
				),
				visitExprGlobal: vi.fn<(node: AstExprGlobal) => boolean>(() => true),
			} satisfies LuauVisitor;

			visitExpression(node, visitor);

			expect(visitor.visitExprCall).toHaveBeenCalledWith(node);
			expect(visitor.visitExprGlobal).toHaveBeenCalledWith(funcExpr);
			expect(visitor.visitExprConstantNumber).toHaveBeenCalledWith(argument);
		});

		it("should dispatch binary expression and recurse into operands", () => {
			expect.assertions(2);

			const rhs = {
				kind: "expr",
				location: span,
				tag: "number",
				value: 2,
			} satisfies AstExprConstantNumber;
			const node = {
				kind: "expr",
				lhsoperand: numberOne,
				location: span,
				rhsoperand: rhs,
				tag: "binary",
			} satisfies AstExprBinary;
			const visitor = {
				visitExprConstantNumber: vi.fn<(node: AstExprConstantNumber) => boolean>(
					() => true,
				),
			} satisfies LuauVisitor;

			visitExpression(node, visitor);

			expect(visitor.visitExprConstantNumber).toHaveBeenCalledTimes(2);
			expect(visitor.visitExprConstantNumber).toHaveBeenCalledWith(numberOne);
		});

		it("should dispatch unary expression and recurse into operand", () => {
			expect.assertions(2);

			const node = {
				kind: "expr",
				location: span,
				operand: numberOne,
				tag: "unary",
			} satisfies AstExprUnary;
			const visitor = {
				visitExprConstantNumber: vi.fn<(node: AstExprConstantNumber) => boolean>(
					() => true,
				),
				visitExprUnary: vi.fn<(node: AstExprUnary) => boolean>(() => true),
			} satisfies LuauVisitor;

			visitExpression(node, visitor);

			expect(visitor.visitExprUnary).toHaveBeenCalledWith(node);
			expect(visitor.visitExprConstantNumber).toHaveBeenCalledWith(numberOne);
		});

		it("should dispatch table expression with list, record, and general items", () => {
			expect.assertions(4);

			const recordValue = {
				kind: "expr",
				location: span,
				tag: "number",
				value: 2,
			} satisfies AstExprConstantNumber;
			const generalKey = {
				kind: "expr",
				location: span,
				tag: "number",
				value: 3,
			} satisfies AstExprConstantNumber;
			const generalValue = {
				kind: "expr",
				location: span,
				tag: "number",
				value: 4,
			} satisfies AstExprConstantNumber;
			const node = {
				entries: [
					{ kind: "list", value: numberOne },
					{ key: { text: "name" }, kind: "record", value: recordValue },
					{ key: generalKey, kind: "general", value: generalValue },
				],
				kind: "expr",
				location: span,
				tag: "table",
			} satisfies AstExprTable;
			const visitor = {
				visitExprConstantNumber: vi.fn<(node: AstExprConstantNumber) => boolean>(
					() => true,
				),
				visitExprTable: vi.fn<(node: AstExprTable) => boolean>(() => true),
			} satisfies LuauVisitor;

			visitExpression(node, visitor);

			expect(visitor.visitExprTable).toHaveBeenCalledWith(node);
			// 3 values + 1 general key = 4 number expressions
			expect(visitor.visitExprConstantNumber).toHaveBeenCalledTimes(4);
			expect(visitor.visitExprConstantNumber).toHaveBeenCalledWith(generalKey);
			expect(visitor.visitExprConstantNumber).toHaveBeenCalledWith(generalValue);
		});

		it("should dispatch group expression and recurse into inner expression", () => {
			expect.assertions(2);

			const node = {
				expression: numberOne,
				kind: "expr",
				location: span,
				tag: "group",
			} satisfies AstExprGroup;
			const visitor = {
				visitExprConstantNumber: vi.fn<(node: AstExprConstantNumber) => boolean>(
					() => true,
				),
				visitExprGroup: vi.fn<(node: AstExprGroup) => boolean>(() => true),
			} satisfies LuauVisitor;

			visitExpression(node, visitor);

			expect(visitor.visitExprGroup).toHaveBeenCalledWith(node);
			expect(visitor.visitExprConstantNumber).toHaveBeenCalledWith(numberOne);
		});

		it("should dispatch indexname expression and recurse into object expression", () => {
			expect.assertions(2);

			const object = {
				name: { text: "foo" },
				kind: "expr",
				location: span,
				tag: "global",
			} satisfies AstExprGlobal;
			const node = {
				accessor: { text: "." },
				expression: object,
				index: { text: "bar" },
				kind: "expr",
				location: span,
				tag: "indexname",
			} satisfies AstExprIndexName;
			const visitor = {
				visitExprGlobal: vi.fn<(node: AstExprGlobal) => boolean>(() => true),
				visitExprIndexName: vi.fn<(node: AstExprIndexName) => boolean>(() => true),
			} satisfies LuauVisitor;

			visitExpression(node, visitor);

			expect(visitor.visitExprIndexName).toHaveBeenCalledWith(node);
			expect(visitor.visitExprGlobal).toHaveBeenCalledWith(object);
		});

		it("should dispatch index expression and recurse into object and index", () => {
			expect.assertions(3);

			const object = {
				name: { text: "t" },
				kind: "expr",
				location: span,
				tag: "global",
			} satisfies AstExprGlobal;
			const node = {
				expression: object,
				index: numberOne,
				kind: "expr",
				location: span,
				tag: "index",
			} satisfies AstExprIndexExpr;
			const visitor = {
				visitExprConstantNumber: vi.fn<(node: AstExprConstantNumber) => boolean>(
					() => true,
				),
				visitExprGlobal: vi.fn<(node: AstExprGlobal) => boolean>(() => true),
				visitExprIndexExpr: vi.fn<(node: AstExprIndexExpr) => boolean>(() => true),
			} satisfies LuauVisitor;

			visitExpression(node, visitor);

			expect(visitor.visitExprIndexExpr).toHaveBeenCalledWith(node);
			expect(visitor.visitExprGlobal).toHaveBeenCalledWith(object);
			expect(visitor.visitExprConstantNumber).toHaveBeenCalledWith(numberOne);
		});

		it("should dispatch interpstring expression and recurse into expressions", () => {
			expect.assertions(2);

			const expr = {
				name: { text: "name" },
				kind: "expr",
				location: span,
				tag: "global",
			} satisfies AstExprGlobal;
			const node = {
				expressions: [expr],
				kind: "expr",
				location: span,
				tag: "interpolatedstring",
			} satisfies AstExprInterpString;
			const visitor = {
				visitExprGlobal: vi.fn<(node: AstExprGlobal) => boolean>(() => true),
				visitExprInterpString: vi.fn<(node: AstExprInterpString) => boolean>(() => true),
			} satisfies LuauVisitor;

			visitExpression(node, visitor);

			expect(visitor.visitExprInterpString).toHaveBeenCalledWith(node);
			expect(visitor.visitExprGlobal).toHaveBeenCalledWith(expr);
		});

		it("should dispatch type assertion expression and recurse into operand", () => {
			expect.assertions(2);

			const node = {
				kind: "expr",
				location: span,
				operand: numberOne,
				tag: "cast",
			} satisfies AstExprTypeAssertion;
			const visitor = {
				visitExprConstantNumber: vi.fn<(node: AstExprConstantNumber) => boolean>(
					() => true,
				),
				visitExprTypeAssertion: vi.fn<(node: AstExprTypeAssertion) => boolean>(() => true),
			} satisfies LuauVisitor;

			visitExpression(node, visitor);

			expect(visitor.visitExprTypeAssertion).toHaveBeenCalledWith(node);
			expect(visitor.visitExprConstantNumber).toHaveBeenCalledWith(numberOne);
		});

		it("should dispatch ifelse expression with condition, then, elseifs, and else", () => {
			expect.assertions(2);

			const elseifThen = {
				kind: "expr",
				location: span,
				tag: "number",
				value: 2,
			} satisfies AstExprConstantNumber;
			const elseexpr = {
				kind: "expr",
				location: span,
				tag: "number",
				value: 3,
			} satisfies AstExprConstantNumber;
			const node = {
				condition: boolTrue,
				elseexpr,
				elseifs: [{ condition: boolFalse, thenexpr: elseifThen }],
				kind: "expr",
				location: span,
				tag: "conditional",
				thenexpr: numberOne,
			} satisfies AstExprIfElse;
			const visitor = {
				visitExprConstantBool: vi.fn<(node: AstExprConstantBool) => boolean>(() => true),
				visitExprConstantNumber: vi.fn<(node: AstExprConstantNumber) => boolean>(
					() => true,
				),
				visitExprIfElse: vi.fn<(node: AstExprIfElse) => boolean>(() => true),
			} satisfies LuauVisitor;

			visitExpression(node, visitor);

			expect(visitor.visitExprIfElse).toHaveBeenCalledWith(node);
			expect(visitor.visitExprConstantNumber).toHaveBeenCalledTimes(3);
		});

		it("should dispatch instantiate expression and recurse into inner expr", () => {
			expect.assertions(2);

			const inner = {
				name: { text: "foo" },
				kind: "expr",
				location: span,
				tag: "global",
			} satisfies AstExprGlobal;
			const node = {
				expr: inner,
				kind: "expr",
				location: span,
				tag: "instantiate",
			} satisfies AstExprInstantiate;
			const visitor = {
				visitExprGlobal: vi.fn<(node: AstExprGlobal) => boolean>(() => true),
				visitExprInstantiate: vi.fn<(node: AstExprInstantiate) => boolean>(() => true),
			} satisfies LuauVisitor;

			visitExpression(node, visitor);

			expect(visitor.visitExprInstantiate).toHaveBeenCalledWith(node);
			expect(visitor.visitExprGlobal).toHaveBeenCalledWith(inner);
		});

		it("should dispatch function expression with body and call visitExprFunctionEnd", () => {
			expect.assertions(3);

			const body = {
				kind: "stat",
				location: span,
				statements: [breakNode],
				tag: "block",
			} satisfies AstStatBlock;
			const node = {
				body,
				kind: "expr",
				location: span,
				tag: "function",
			} satisfies AstExprFunction;
			const visitor = {
				visitExprFunction: vi.fn<(node: AstExprFunction) => boolean>(() => true),
				visitExprFunctionEnd: vi.fn<(node: AstExprFunction) => void>(),
				visitStatBreak: vi.fn<(node: AstStatBreak) => boolean>(() => true),
			} satisfies LuauVisitor;

			visitExpression(node, visitor);

			expect(visitor.visitExprFunction).toHaveBeenCalledWith(node);
			expect(visitor.visitStatBreak).toHaveBeenCalledWith(breakNode);
			expect(visitor.visitExprFunctionEnd).toHaveBeenCalledWith(node);
		});

		it("should dispatch remaining leaf expression types", () => {
			expect.assertions(5);

			const nilNode = {
				kind: "expr",
				location: span,
				tag: "nil",
			} satisfies AstExprConstantNil;
			const stringNode = {
				kind: "expr",
				location: span,
				tag: "string",
				value: "hi",
			} satisfies AstExprConstantString;
			const localNode = {
				kind: "expr",
				location: span,
				tag: "local",
				token: {},
			} satisfies AstExprLocal;
			const globalNode = {
				name: { text: "x" },
				kind: "expr",
				location: span,
				tag: "global",
			} satisfies AstExprGlobal;
			const varargNode = {
				kind: "expr",
				location: span,
				tag: "vararg",
			} satisfies AstExprVarargs;

			const visitor: LuauVisitor = {
				visitExprConstantNil: vi.fn<(node: AstExprConstantNil) => boolean>(() => true),
				visitExprConstantString: vi.fn<(node: AstExprConstantString) => boolean>(
					() => true,
				),
				visitExprGlobal: vi.fn<(node: AstExprGlobal) => boolean>(() => true),
				visitExprLocal: vi.fn<(node: AstExprLocal) => boolean>(() => true),
				visitExprVarargs: vi.fn<(node: AstExprVarargs) => boolean>(() => true),
			};

			visitExpression(nilNode, visitor);
			visitExpression(stringNode, visitor);
			visitExpression(localNode, visitor);
			visitExpression(globalNode, visitor);
			visitExpression(varargNode, visitor);

			expect(visitor.visitExprConstantNil).toHaveBeenCalledWith(nilNode);
			expect(visitor.visitExprConstantString).toHaveBeenCalledWith(stringNode);
			expect(visitor.visitExprLocal).toHaveBeenCalledWith(localNode);
			expect(visitor.visitExprGlobal).toHaveBeenCalledWith(globalNode);
			expect(visitor.visitExprVarargs).toHaveBeenCalledWith(varargNode);
		});

		it("should silently skip unknown expression tags", () => {
			expect.assertions(1);

			const node = {
				kind: "expr",
				location: span,
				tag: "unknown",
			} as unknown as AstExpr;

			expect(() => {
				visitExpression(node, {});
			}).not.toThrow();
		});

		it("should skip children when visitor callbacks return false", () => {
			expect.assertions(5);

			const numberVisitor = vi.fn<(node: AstExprConstantNumber) => boolean>(() => true);

			// call: skip children
			const callNode = {
				arguments: [{ node: numberOne }],
				func: numberOne,
				kind: "expr",
				location: span,
				tag: "call",
			} satisfies AstExprCall;
			visitExpression(callNode, {
				visitExprCall: () => false,
				visitExprConstantNumber: numberVisitor,
			});

			expect(numberVisitor).not.toHaveBeenCalled();

			// binary: skip children
			const binaryNode = {
				kind: "expr",
				lhsoperand: numberOne,
				location: span,
				rhsoperand: numberOne,
				tag: "binary",
			} satisfies AstExprBinary;

			visitExpression(binaryNode, {
				visitExprBinary: () => false,
				visitExprConstantNumber: numberVisitor,
			});

			expect(numberVisitor).not.toHaveBeenCalled();

			// table: skip children
			const tableNode = {
				entries: [{ kind: "list", value: numberOne }],
				kind: "expr",
				location: span,
				tag: "table",
			} satisfies AstExprTable;
			visitExpression(tableNode, {
				visitExprConstantNumber: numberVisitor,
				visitExprTable: () => false,
			});

			expect(numberVisitor).not.toHaveBeenCalled();

			// ifelse: skip children
			const ifelseNode = {
				condition: numberOne,
				elseexpr: numberOne,
				elseifs: [],
				kind: "expr",
				location: span,
				tag: "conditional",
				thenexpr: numberOne,
			} satisfies AstExprIfElse;
			visitExpression(ifelseNode, {
				visitExprConstantNumber: numberVisitor,
				visitExprIfElse: () => false,
			});

			expect(numberVisitor).not.toHaveBeenCalled();

			// function: skip children
			const funcNode = {
				body: emptyBlock(),
				kind: "expr",
				location: span,
				tag: "function",
			} satisfies AstExprFunction;
			const blockVisitor = vi.fn<(node: AstStatBlock) => boolean>(() => true);
			const funcEndVisitor = vi.fn<(node: AstExprFunction) => void>();
			visitExpression(funcNode, {
				visitExprFunction: () => false,
				visitExprFunctionEnd: funcEndVisitor,
				visitStatBlock: blockVisitor,
			});

			expect(blockVisitor).not.toHaveBeenCalled();
		});

		it("should skip children when statement visitor callbacks return false", () => {
			expect.assertions(5);

			const body: AstStatBlock = {
				kind: "stat",
				location: span,
				statements: [breakNode],
				tag: "block",
			};
			const breakVisitor = vi.fn<(node: AstStatBreak) => boolean>(() => true);
			const numberVisitor = vi.fn<(node: AstExprConstantNumber) => boolean>(() => true);

			// if: skip children
			const ifNode = {
				condition: numberOne,
				elseifs: [],
				kind: "stat",
				location: span,
				tag: "conditional",
				thenblock: body,
			} satisfies AstStatIf;
			visitStatement(ifNode, { visitStatBreak: breakVisitor, visitStatIf: () => false });

			expect(breakVisitor).not.toHaveBeenCalled();

			// while: skip children
			const whileNode = {
				body,
				condition: numberOne,
				kind: "stat",
				location: span,
				tag: "while",
			} satisfies AstStatWhile;
			visitStatement(whileNode, {
				visitStatBreak: breakVisitor,
				visitStatWhile: () => false,
			});

			expect(breakVisitor).not.toHaveBeenCalled();

			// repeat: skip children
			const repeatNode = {
				body,
				condition: numberOne,
				kind: "stat",
				location: span,
				tag: "repeat",
			} satisfies AstStatRepeat;

			visitStatement(repeatNode, {
				visitStatBreak: breakVisitor,
				visitStatRepeat: () => false,
			});

			expect(breakVisitor).not.toHaveBeenCalled();

			// local: skip children
			const localNode = {
				kind: "stat",
				location: span,
				tag: "local",
				values: [{ node: numberOne }],
				variables: [],
			} satisfies AstStatLocal;
			visitStatement(localNode, {
				visitExprConstantNumber: numberVisitor,
				visitStatLocal: () => false,
			});

			expect(numberVisitor).not.toHaveBeenCalled();

			// return: skip children
			const returnNode = {
				expressions: [{ node: numberOne }],
				kind: "stat",
				location: span,
				tag: "return",
			} satisfies AstStatReturn;
			visitStatement(returnNode, {
				visitExprConstantNumber: numberVisitor,
				visitStatReturn: () => false,
			});

			expect(numberVisitor).not.toHaveBeenCalled();
		});

		it("should skip children for remaining skip-children branches", () => {
			expect.assertions(7);

			const body = {
				kind: "stat",
				location: span,
				statements: [breakNode],
				tag: "block",
			} satisfies AstStatBlock;
			const breakVisitor = vi.fn<(node: AstStatBreak) => boolean>(() => true);
			const numberVisitor = vi.fn<(node: AstExprConstantNumber) => boolean>(() => true);

			// do: skip
			visitStatement({ body, kind: "stat", location: span, tag: "do" } satisfies AstStatDo, {
				visitStatBreak: breakVisitor,
				visitStatDo: () => false,
			});

			expect(breakVisitor).not.toHaveBeenCalled();

			// for: skip
			visitStatement(
				{
					body,
					from: numberOne,
					kind: "stat",
					location: span,
					tag: "for",
					to: numberOne,
				} satisfies AstStatFor,
				{
					visitExprConstantNumber: numberVisitor,
					visitStatBreak: breakVisitor,
					visitStatFor: () => false,
				},
			);

			expect(breakVisitor).not.toHaveBeenCalled();

			// forin: skip
			visitStatement(
				{
					body,
					kind: "stat",
					location: span,
					tag: "forin",
					values: [{ node: numberOne }],
				} satisfies AstStatForIn,
				{ visitStatBreak: breakVisitor, visitStatForIn: () => false },
			);

			expect(breakVisitor).not.toHaveBeenCalled();

			// assign: skip
			visitStatement(
				{
					kind: "stat",
					location: span,
					tag: "assign",
					values: [{ node: numberOne }],
					variables: [{ node: numberOne }],
				} satisfies AstStatAssign,
				{ visitExprConstantNumber: numberVisitor, visitStatAssign: () => false },
			);

			expect(numberVisitor).not.toHaveBeenCalled();

			// compoundassign: skip
			visitStatement(
				{
					kind: "stat",
					location: span,
					tag: "compoundassign",
					value: numberOne,
					variable: numberOne,
				} satisfies AstStatCompoundAssign,
				{
					visitExprConstantNumber: numberVisitor,
					visitStatCompoundAssign: () => false,
				},
			);

			expect(numberVisitor).not.toHaveBeenCalled();

			// expression: skip
			visitStatement(
				{
					expression: numberOne,
					kind: "stat",
					location: span,
					tag: "expression",
				} satisfies AstStatExpr,
				{ visitExprConstantNumber: numberVisitor, visitStatExpr: () => false },
			);

			expect(numberVisitor).not.toHaveBeenCalled();

			// unary: skip
			visitExpression(
				{
					kind: "expr",
					location: span,
					operand: numberOne,
					tag: "unary",
				} satisfies AstExprUnary,
				{ visitExprConstantNumber: numberVisitor, visitExprUnary: () => false },
			);

			expect(numberVisitor).not.toHaveBeenCalled();
		});

		it("should skip children for remaining expression skip-children branches", () => {
			expect.assertions(5);

			const numberVisitor = vi.fn<(node: AstExprConstantNumber) => boolean>(() => true);

			// group: skip
			visitExpression(
				{
					expression: numberOne,
					kind: "expr",
					location: span,
					tag: "group",
				} satisfies AstExprGroup,
				{ visitExprConstantNumber: numberVisitor, visitExprGroup: () => false },
			);

			expect(numberVisitor).not.toHaveBeenCalled();

			// indexname: skip
			visitExpression(
				{
					accessor: { text: "." },
					expression: numberOne,
					index: { text: "x" },
					kind: "expr",
					location: span,
					tag: "indexname",
				} satisfies AstExprIndexName,
				{ visitExprConstantNumber: numberVisitor, visitExprIndexName: () => false },
			);

			expect(numberVisitor).not.toHaveBeenCalled();

			// indexexpr: skip
			visitExpression(
				{
					expression: numberOne,
					index: numberOne,
					kind: "expr",
					location: span,
					tag: "index",
				} satisfies AstExprIndexExpr,
				{ visitExprConstantNumber: numberVisitor, visitExprIndexExpr: () => false },
			);

			expect(numberVisitor).not.toHaveBeenCalled();

			// interpstring: skip
			visitExpression(
				{
					expressions: [numberOne],
					kind: "expr",
					location: span,
					tag: "interpolatedstring",
				} satisfies AstExprInterpString,
				{ visitExprConstantNumber: numberVisitor, visitExprInterpString: () => false },
			);

			expect(numberVisitor).not.toHaveBeenCalled();

			// typeassertion: skip
			visitExpression(
				{
					kind: "expr",
					location: span,
					operand: numberOne,
					tag: "cast",
				} satisfies AstExprTypeAssertion,
				{
					visitExprConstantNumber: numberVisitor,
					visitExprTypeAssertion: () => false,
				},
			);

			expect(numberVisitor).not.toHaveBeenCalled();
		});

		it("should skip children for function and localfunction statement skips", () => {
			expect.assertions(2);

			const body = emptyBlock() satisfies AstStatBlock;
			const func = {
				body,
				kind: "expr",
				location: span,
				tag: "function",
			} satisfies AstExprFunction;
			const blockVisitor = vi.fn<(node: AstStatBlock) => boolean>(() => true);

			// statfunction: skip
			visitStatement(
				{
					name: {
						name: { text: "f" },
						kind: "expr",
						location: span,
						tag: "global",
					} satisfies AstExprGlobal,
					func,
					kind: "stat",
					location: span,
					tag: "function",
				} satisfies AstStatFunction,
				{ visitStatBlock: blockVisitor, visitStatFunction: () => false },
			);

			expect(blockVisitor).not.toHaveBeenCalled();

			// statlocalfunction: skip
			visitStatement(
				{
					name: { name: { text: "f" }, kind: "local", location: span },
					func,
					kind: "stat",
					location: span,
					tag: "localfunction",
				} satisfies AstStatLocalFunction,
				{ visitStatBlock: blockVisitor, visitStatLocalFunction: () => false },
			);

			expect(blockVisitor).not.toHaveBeenCalled();
		});

		it("should skip children for instantiate and tableExprItem skips", () => {
			expect.assertions(2);

			const numberVisitor = vi.fn<(node: AstExprConstantNumber) => boolean>(() => true);

			// instantiate: skip
			visitExpression(
				{
					expr: numberOne,
					kind: "expr",
					location: span,
					tag: "instantiate",
				} satisfies AstExprInstantiate,
				{ visitExprConstantNumber: numberVisitor, visitExprInstantiate: () => false },
			);

			expect(numberVisitor).not.toHaveBeenCalled();

			// table with visitTableExprItem returning false: skip item values
			const tableNode = {
				entries: [{ kind: "list", value: numberOne }],
				kind: "expr",
				location: span,
				tag: "table",
			} satisfies AstExprTable;
			visitExpression(tableNode, {
				visitExprConstantNumber: numberVisitor,
				visitTableExprItem: () => false,
			});

			expect(numberVisitor).not.toHaveBeenCalled();
		});

		it("should dispatch block tag in visitStatement", () => {
			expect.assertions(1);

			const block = {
				kind: "stat",
				location: span,
				statements: [breakNode],
				tag: "block",
			} satisfies AstStatBlock;
			const visitor = {
				visitStatBreak: vi.fn<(node: AstStatBreak) => boolean>(() => true),
			} satisfies LuauVisitor;

			visitStatement(block, visitor);

			expect(visitor.visitStatBreak).toHaveBeenCalledWith(breakNode);
		});

		it("should dispatch if statement without elseblock", () => {
			expect.assertions(2);

			const thenblock = {
				kind: "stat",
				location: span,
				statements: [breakNode],
				tag: "block",
			} satisfies AstStatBlock;
			const node = {
				condition: boolTrue,
				elseifs: [],
				kind: "stat",
				location: span,
				tag: "conditional",
				thenblock,
			} satisfies AstStatIf;
			const visitor = {
				visitStatBreak: vi.fn<(node: AstStatBreak) => boolean>(() => true),
				visitStatIf: vi.fn<(node: AstStatIf) => boolean>(() => true),
			} satisfies LuauVisitor;

			visitStatement(node, visitor);

			expect(visitor.visitStatIf).toHaveBeenCalledWith(node);
			expect(visitor.visitStatBreak).toHaveBeenCalledWith(breakNode);
		});
	});
});
