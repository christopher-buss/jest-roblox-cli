/**
 * Visitor pattern for traversing Lute's Luau AST.
 * Mirrors @std/syntax/visitor.luau — each callback returns boolean
 * (false = skip children). All callbacks optional, default true.
 *
 * We skip type/token visitors since coverage instrumentation doesn't need them.
 */
import type {
	AstElseIfExpr,
	AstElseIfStat,
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
	AstTableExprItem,
	Punctuated,
} from "./ast-types.ts";

export interface LuauVisitor {
	visitExpr?(node: AstExpr): boolean;
	visitExprBinary?(node: AstExprBinary): boolean;
	visitExprCall?(node: AstExprCall): boolean;
	visitExprConstantBool?(node: AstExprConstantBool): boolean;
	visitExprConstantNil?(node: AstExprConstantNil): boolean;
	visitExprConstantNumber?(node: AstExprConstantNumber): boolean;
	visitExprConstantString?(node: AstExprConstantString): boolean;
	visitExprEnd?(node: AstExpr): void;
	visitExprFunction?(node: AstExprFunction): boolean;
	visitExprFunctionEnd?(node: AstExprFunction): void;
	visitExprGlobal?(node: AstExprGlobal): boolean;
	visitExprGroup?(node: AstExprGroup): boolean;
	visitExprIfElse?(node: AstExprIfElse): boolean;
	visitExprIndexExpr?(node: AstExprIndexExpr): boolean;
	visitExprIndexName?(node: AstExprIndexName): boolean;
	visitExprInstantiate?(node: AstExprInstantiate): boolean;
	visitExprInterpString?(node: AstExprInterpString): boolean;
	visitExprLocal?(node: AstExprLocal): boolean;
	visitExprTable?(node: AstExprTable): boolean;
	visitExprTypeAssertion?(node: AstExprTypeAssertion): boolean;
	visitExprUnary?(node: AstExprUnary): boolean;
	visitExprVarargs?(node: AstExprVarargs): boolean;

	visitStatAssign?(node: AstStatAssign): boolean;
	visitStatBlock?(node: AstStatBlock): boolean;
	visitStatBlockEnd?(node: AstStatBlock): void;
	visitStatBreak?(node: AstStatBreak): boolean;
	visitStatCompoundAssign?(node: AstStatCompoundAssign): boolean;
	visitStatContinue?(node: AstStatContinue): boolean;
	visitStatDo?(node: AstStatDo): boolean;
	visitStatExpr?(node: AstStatExpr): boolean;
	visitStatFor?(node: AstStatFor): boolean;
	visitStatForIn?(node: AstStatForIn): boolean;
	visitStatFunction?(node: AstStatFunction): boolean;
	visitStatIf?(node: AstStatIf): boolean;
	visitStatLocal?(node: AstStatLocal): boolean;
	visitStatLocalFunction?(node: AstStatLocalFunction): boolean;
	visitStatRepeat?(node: AstStatRepeat): boolean;
	visitStatReturn?(node: AstStatReturn): boolean;
	visitStatTypeAlias?(node: AstStatTypeAlias): boolean;
	visitStatTypeFunction?(node: AstStatTypeFunction): boolean;
	visitStatWhile?(node: AstStatWhile): boolean;

	visitTableExprItem?(node: AstTableExprItem): boolean;
}

export function visitExpression(expression: AstExpr, visitor: LuauVisitor): void {
	if (visitor.visitExpr?.(expression) === false) {
		return;
	}

	const { tag } = expression;
	switch (tag) {
		case "binary": {
			visitExprBinary(expression, visitor);
			break;
		}
		case "boolean": {
			visitor.visitExprConstantBool?.(expression);
			break;
		}
		case "call": {
			visitExprCall(expression, visitor);
			break;
		}
		case "cast": {
			visitExprTypeAssertion(expression, visitor);
			break;
		}
		case "conditional": {
			visitExprIfElse(expression, visitor);
			break;
		}
		case "function": {
			visitExprFunction(expression, visitor);
			break;
		}
		case "global": {
			visitor.visitExprGlobal?.(expression);
			break;
		}
		case "group": {
			visitExprGroup(expression, visitor);
			break;
		}
		case "index": {
			visitExprIndexExpr(expression, visitor);
			break;
		}
		case "indexname": {
			visitExprIndexName(expression, visitor);
			break;
		}
		case "instantiate": {
			visitExprInstantiate(expression, visitor);
			break;
		}
		case "interpolatedstring": {
			visitExprInterpString(expression, visitor);
			break;
		}
		case "local": {
			visitor.visitExprLocal?.(expression);
			break;
		}
		case "nil": {
			visitor.visitExprConstantNil?.(expression);
			break;
		}
		case "number": {
			visitor.visitExprConstantNumber?.(expression);
			break;
		}
		case "string": {
			visitor.visitExprConstantString?.(expression);
			break;
		}
		case "table": {
			visitExprTable(expression, visitor);
			break;
		}
		case "unary": {
			visitExprUnary(expression, visitor);
			break;
		}
		case "vararg": {
			visitor.visitExprVarargs?.(expression);
			break;
		}
		default: {
			break;
		}
	}

	visitor.visitExprEnd?.(expression);
}

export function visitStatement(statement: AstStat, visitor: LuauVisitor): void {
	const { tag } = statement;
	switch (tag) {
		case "assign": {
			visitStatAssign(statement, visitor);
			break;
		}
		case "block": {
			visitStatBlock(statement, visitor);
			break;
		}
		case "break": {
			visitor.visitStatBreak?.(statement);
			break;
		}
		case "compoundassign": {
			visitStatCompoundAssign(statement, visitor);
			break;
		}
		case "conditional": {
			visitStatIf(statement, visitor);
			break;
		}
		case "continue": {
			visitor.visitStatContinue?.(statement);
			break;
		}
		case "do": {
			visitStatDo(statement, visitor);
			break;
		}
		case "expression": {
			visitStatExpr(statement, visitor);
			break;
		}
		case "for": {
			visitStatFor(statement, visitor);
			break;
		}
		case "forin": {
			visitStatForIn(statement, visitor);
			break;
		}
		case "function": {
			visitStatFunction(statement, visitor);
			break;
		}
		case "local": {
			visitStatLocal(statement, visitor);
			break;
		}
		case "localfunction": {
			visitStatLocalFunction(statement, visitor);
			break;
		}
		case "repeat": {
			visitStatRepeat(statement, visitor);
			break;
		}
		case "return": {
			visitStatReturn(statement, visitor);
			break;
		}
		case "typealias": {
			visitor.visitStatTypeAlias?.(statement);
			break;
		}
		case "typefunction": {
			visitor.visitStatTypeFunction?.(statement);
			break;
		}
		case "while": {
			visitStatWhile(statement, visitor);
			break;
		}
		default: {
			break;
		}
	}
}

export function visitBlock(block: AstStatBlock, visitor: LuauVisitor): void {
	visitStatBlock(block, visitor);
}

function visitPunctuated<T>(
	list: Punctuated<T>,
	visitor: LuauVisitor,
	apply: (node: T, visitor: LuauVisitor) => void,
): void {
	for (const item of list) {
		apply(item.node, visitor);
	}
}

function visitStatBlock(block: AstStatBlock, visitor: LuauVisitor): void {
	if (visitor.visitStatBlock?.(block) === false) {
		return;
	}

	for (const statement of block.statements) {
		visitStatement(statement, visitor);
	}

	visitor.visitStatBlockEnd?.(block);
}

function visitStatDo(node: AstStatDo, visitor: LuauVisitor): void {
	if (visitor.visitStatDo?.(node) === false) {
		return;
	}

	visitStatBlock(node.body, visitor);
}

function visitStatIf(node: AstStatIf, visitor: LuauVisitor): void {
	if (visitor.visitStatIf?.(node) === false) {
		return;
	}

	visitExpression(node.condition, visitor);
	visitStatBlock(node.thenblock, visitor);
	for (const elseif of node.elseifs) {
		visitElseIfStat(elseif, visitor);
	}

	if (node.elseblock) {
		visitStatBlock(node.elseblock, visitor);
	}
}

function visitElseIfStat(node: AstElseIfStat, visitor: LuauVisitor): void {
	visitExpression(node.condition, visitor);
	visitStatBlock(node.thenblock, visitor);
}

function visitStatWhile(node: AstStatWhile, visitor: LuauVisitor): void {
	if (visitor.visitStatWhile?.(node) === false) {
		return;
	}

	visitExpression(node.condition, visitor);
	visitStatBlock(node.body, visitor);
}

function visitStatRepeat(node: AstStatRepeat, visitor: LuauVisitor): void {
	if (visitor.visitStatRepeat?.(node) === false) {
		return;
	}

	visitStatBlock(node.body, visitor);
	visitExpression(node.condition, visitor);
}

function visitStatReturn(node: AstStatReturn, visitor: LuauVisitor): void {
	if (visitor.visitStatReturn?.(node) === false) {
		return;
	}

	visitPunctuated(node.expressions, visitor, visitExpression);
}

function visitStatLocal(node: AstStatLocal, visitor: LuauVisitor): void {
	if (visitor.visitStatLocal?.(node) === false) {
		return;
	}

	visitPunctuated(node.values, visitor, visitExpression);
}

function visitStatFor(node: AstStatFor, visitor: LuauVisitor): void {
	if (visitor.visitStatFor?.(node) === false) {
		return;
	}

	visitExpression(node.from, visitor);
	visitExpression(node.to, visitor);
	if (node.step) {
		visitExpression(node.step, visitor);
	}

	visitStatBlock(node.body, visitor);
}

function visitStatForIn(node: AstStatForIn, visitor: LuauVisitor): void {
	if (visitor.visitStatForIn?.(node) === false) {
		return;
	}

	visitPunctuated(node.values, visitor, visitExpression);
	visitStatBlock(node.body, visitor);
}

function visitStatAssign(node: AstStatAssign, visitor: LuauVisitor): void {
	if (visitor.visitStatAssign?.(node) === false) {
		return;
	}

	visitPunctuated(node.variables, visitor, visitExpression);
	visitPunctuated(node.values, visitor, visitExpression);
}

function visitStatCompoundAssign(node: AstStatCompoundAssign, visitor: LuauVisitor): void {
	if (visitor.visitStatCompoundAssign?.(node) === false) {
		return;
	}

	visitExpression(node.variable, visitor);
	visitExpression(node.value, visitor);
}

function visitStatExpr(node: AstStatExpr, visitor: LuauVisitor): void {
	if (visitor.visitStatExpr?.(node) === false) {
		return;
	}

	visitExpression(node.expression, visitor);
}

function visitStatFunction(node: AstStatFunction, visitor: LuauVisitor): void {
	if (visitor.visitStatFunction?.(node) === false) {
		return;
	}

	visitExpression(node.name, visitor);
	visitExprFunction(node.func, visitor);
}

function visitStatLocalFunction(node: AstStatLocalFunction, visitor: LuauVisitor): void {
	if (visitor.visitStatLocalFunction?.(node) === false) {
		return;
	}

	visitExprFunction(node.func, visitor);
}

function visitExprFunction(node: AstExprFunction, visitor: LuauVisitor): void {
	if (visitor.visitExprFunction?.(node) === false) {
		return;
	}

	visitStatBlock(node.body, visitor);
	visitor.visitExprFunctionEnd?.(node);
}

function visitExprCall(node: AstExprCall, visitor: LuauVisitor): void {
	if (visitor.visitExprCall?.(node) === false) {
		return;
	}

	visitExpression(node.func, visitor);
	visitPunctuated(node.arguments, visitor, visitExpression);
}

function visitExprUnary(node: AstExprUnary, visitor: LuauVisitor): void {
	if (visitor.visitExprUnary?.(node) === false) {
		return;
	}

	visitExpression(node.operand, visitor);
}

function visitExprBinary(node: AstExprBinary, visitor: LuauVisitor): void {
	if (visitor.visitExprBinary?.(node) === false) {
		return;
	}

	visitExpression(node.lhsoperand, visitor);
	visitExpression(node.rhsoperand, visitor);
}

function visitExprTable(node: AstExprTable, visitor: LuauVisitor): void {
	if (visitor.visitExprTable?.(node) === false) {
		return;
	}

	for (const item of node.entries) {
		visitTableExprItem(item, visitor);
	}
}

function visitTableExprItem(node: AstTableExprItem, visitor: LuauVisitor): void {
	if (visitor.visitTableExprItem?.(node) === false) {
		return;
	}

	visitExpression(node.value, visitor);
	if (node.kind === "general") {
		visitExpression(node.key, visitor);
	}
}

function visitExprIndexName(node: AstExprIndexName, visitor: LuauVisitor): void {
	if (visitor.visitExprIndexName?.(node) === false) {
		return;
	}

	visitExpression(node.expression, visitor);
}

function visitExprIndexExpr(node: AstExprIndexExpr, visitor: LuauVisitor): void {
	if (visitor.visitExprIndexExpr?.(node) === false) {
		return;
	}

	visitExpression(node.expression, visitor);
	visitExpression(node.index, visitor);
}

function visitExprGroup(node: AstExprGroup, visitor: LuauVisitor): void {
	if (visitor.visitExprGroup?.(node) === false) {
		return;
	}

	visitExpression(node.expression, visitor);
}

function visitExprInterpString(node: AstExprInterpString, visitor: LuauVisitor): void {
	if (visitor.visitExprInterpString?.(node) === false) {
		return;
	}

	for (const expr of node.expressions) {
		visitExpression(expr, visitor);
	}
}

function visitExprTypeAssertion(node: AstExprTypeAssertion, visitor: LuauVisitor): void {
	if (visitor.visitExprTypeAssertion?.(node) === false) {
		return;
	}

	visitExpression(node.operand, visitor);
}

function visitExprIfElse(node: AstExprIfElse, visitor: LuauVisitor): void {
	if (visitor.visitExprIfElse?.(node) === false) {
		return;
	}

	visitExpression(node.condition, visitor);
	visitExpression(node.thenexpr, visitor);
	for (const elseif of node.elseifs) {
		visitElseIfExpr(elseif, visitor);
	}

	visitExpression(node.elseexpr, visitor);
}

function visitElseIfExpr(node: AstElseIfExpr, visitor: LuauVisitor): void {
	visitExpression(node.condition, visitor);
	visitExpression(node.thenexpr, visitor);
}

function visitExprInstantiate(node: AstExprInstantiate, visitor: LuauVisitor): void {
	if (visitor.visitExprInstantiate?.(node) === false) {
		return;
	}

	visitExpression(node.expr, visitor);
}
