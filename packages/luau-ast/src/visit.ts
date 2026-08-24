/* eslint-disable max-lines -- Visitor pattern is inherently verbose. */
/**
 * Visitor over the official parser's AST (see ast.ts). Each enter callback
 * returns boolean — false skips the node's children. All callbacks optional,
 * default true. Type-annotation nodes are not visited.
 */
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
	AstExprInterpString,
	AstExprLocal,
	AstExprTable,
	AstExprTableItem,
	AstExprTypeAssertion,
	AstExprUnary,
	AstExprVarargs,
	AstStat,
	AstStatAssign,
	AstStatBlock,
	AstStatBreak,
	AstStatCompoundAssign,
	AstStatContinue,
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
	AstStatWhile,
} from "./ast.ts";

export interface LuauVisitor {
	visitExpr?: (node: AstExpr) => boolean;
	visitExprBinary?: (node: AstExprBinary) => boolean;
	visitExprCall?: (node: AstExprCall) => boolean;
	visitExprConstantBool?: (node: AstExprConstantBool) => boolean;
	visitExprConstantNil?: (node: AstExprConstantNil) => boolean;
	visitExprConstantNumber?: (node: AstExprConstantNumber) => boolean;
	visitExprConstantString?: (node: AstExprConstantString) => boolean;
	visitExprEnd?: (node: AstExpr) => void;
	visitExprFunction?: (node: AstExprFunction) => boolean;
	visitExprFunctionEnd?: (node: AstExprFunction) => void;
	visitExprGlobal?: (node: AstExprGlobal) => boolean;
	visitExprGroup?: (node: AstExprGroup) => boolean;
	visitExprIfElse?: (node: AstExprIfElse) => boolean;
	visitExprIndexExpr?: (node: AstExprIndexExpr) => boolean;
	visitExprIndexName?: (node: AstExprIndexName) => boolean;
	visitExprInterpString?: (node: AstExprInterpString) => boolean;
	visitExprLocal?: (node: AstExprLocal) => boolean;
	visitExprTable?: (node: AstExprTable) => boolean;
	visitExprTypeAssertion?: (node: AstExprTypeAssertion) => boolean;
	visitExprUnary?: (node: AstExprUnary) => boolean;
	visitExprVarargs?: (node: AstExprVarargs) => boolean;

	visitStatAssign?: (node: AstStatAssign) => boolean;
	visitStatBlock?: (node: AstStatBlock) => boolean;
	visitStatBlockEnd?: (node: AstStatBlock) => void;
	visitStatBreak?: (node: AstStatBreak) => boolean;
	visitStatCompoundAssign?: (node: AstStatCompoundAssign) => boolean;
	visitStatContinue?: (node: AstStatContinue) => boolean;
	visitStatExpr?: (node: AstStatExpr) => boolean;
	visitStatFor?: (node: AstStatFor) => boolean;
	visitStatForIn?: (node: AstStatForIn) => boolean;
	visitStatFunction?: (node: AstStatFunction) => boolean;
	visitStatIf?: (node: AstStatIf) => boolean;
	visitStatLocal?: (node: AstStatLocal) => boolean;
	visitStatLocalFunction?: (node: AstStatLocalFunction) => boolean;
	visitStatRepeat?: (node: AstStatRepeat) => boolean;
	visitStatReturn?: (node: AstStatReturn) => boolean;
	visitStatTypeAlias?: (node: AstStatTypeAlias) => boolean;
	visitStatWhile?: (node: AstStatWhile) => boolean;

	visitTableItem?: (node: AstExprTableItem) => boolean;
}

export function visitBlock(block: AstStatBlock, visitor: LuauVisitor): void {
	visitStatBlock(block, visitor);
}

// eslint-disable-next-line flawless/max-lines-per-function -- Visitor pattern is inherently verbose.
export function visitExpression(expression: AstExpr, visitor: LuauVisitor): void {
	if (visitor.visitExpr?.(expression) === false) {
		return;
	}

	switch (expression.type) {
		case "AstExprBinary": {
			visitExprBinary(expression, visitor);
			break;
		}
		case "AstExprCall": {
			visitExprCall(expression, visitor);
			break;
		}
		case "AstExprConstantBool": {
			visitor.visitExprConstantBool?.(expression);
			break;
		}
		case "AstExprConstantNil": {
			visitor.visitExprConstantNil?.(expression);
			break;
		}
		case "AstExprConstantNumber": {
			visitor.visitExprConstantNumber?.(expression);
			break;
		}
		case "AstExprConstantString": {
			visitor.visitExprConstantString?.(expression);
			break;
		}
		case "AstExprFunction": {
			visitExprFunction(expression, visitor);
			break;
		}
		case "AstExprGlobal": {
			visitor.visitExprGlobal?.(expression);
			break;
		}
		case "AstExprGroup": {
			visitExprGroup(expression, visitor);
			break;
		}
		case "AstExprIfElse": {
			visitExprIfElse(expression, visitor);
			break;
		}
		case "AstExprIndexExpr": {
			visitExprIndexExpr(expression, visitor);
			break;
		}
		case "AstExprIndexName": {
			visitExprIndexName(expression, visitor);
			break;
		}
		case "AstExprInterpString": {
			visitExprInterpString(expression, visitor);
			break;
		}
		case "AstExprLocal": {
			visitor.visitExprLocal?.(expression);
			break;
		}
		case "AstExprTable": {
			visitExprTable(expression, visitor);
			break;
		}
		case "AstExprTypeAssertion": {
			visitExprTypeAssertion(expression, visitor);
			break;
		}
		case "AstExprUnary": {
			visitExprUnary(expression, visitor);
			break;
		}
		case "AstExprVarargs": {
			visitor.visitExprVarargs?.(expression);
			break;
		}
		default: {
			break;
		}
	}

	visitor.visitExprEnd?.(expression);
}

// eslint-disable-next-line flawless/max-lines-per-function -- Visitor pattern is inherently verbose.
export function visitStatement(statement: AstStat, visitor: LuauVisitor): void {
	switch (statement.type) {
		case "AstStatAssign": {
			visitStatAssign(statement, visitor);
			break;
		}
		case "AstStatBlock": {
			visitStatBlock(statement, visitor);
			break;
		}
		case "AstStatBreak": {
			visitor.visitStatBreak?.(statement);
			break;
		}
		case "AstStatCompoundAssign": {
			visitStatCompoundAssign(statement, visitor);
			break;
		}
		case "AstStatContinue": {
			visitor.visitStatContinue?.(statement);
			break;
		}
		case "AstStatExpr": {
			visitStatExpr(statement, visitor);
			break;
		}
		case "AstStatFor": {
			visitStatFor(statement, visitor);
			break;
		}
		case "AstStatForIn": {
			visitStatForIn(statement, visitor);
			break;
		}
		case "AstStatFunction": {
			visitStatFunction(statement, visitor);
			break;
		}
		case "AstStatIf": {
			visitStatIf(statement, visitor);
			break;
		}
		case "AstStatLocal": {
			visitStatLocal(statement, visitor);
			break;
		}
		case "AstStatLocalFunction": {
			visitStatLocalFunction(statement, visitor);
			break;
		}
		case "AstStatRepeat": {
			visitStatRepeat(statement, visitor);
			break;
		}
		case "AstStatReturn": {
			visitStatReturn(statement, visitor);
			break;
		}
		case "AstStatTypeAlias": {
			visitor.visitStatTypeAlias?.(statement);
			break;
		}
		case "AstStatWhile": {
			visitStatWhile(statement, visitor);
			break;
		}
		default: {
			break;
		}
	}
}

function visitStatCompoundAssign(node: AstStatCompoundAssign, visitor: LuauVisitor): void {
	if (visitor.visitStatCompoundAssign?.(node) === false) {
		return;
	}

	visitExpression(node.var, visitor);
	visitExpression(node.value, visitor);
}

function visitStatExpr(node: AstStatExpr, visitor: LuauVisitor): void {
	if (visitor.visitStatExpr?.(node) === false) {
		return;
	}

	visitExpression(node.expr, visitor);
}

function visitStatFunction(node: AstStatFunction, visitor: LuauVisitor): void {
	if (visitor.visitStatFunction?.(node) === false) {
		return;
	}

	visitExpression(node.name, visitor);
	visitExprFunction(node.func, visitor);
}

function visitStatLocal(node: AstStatLocal, visitor: LuauVisitor): void {
	if (visitor.visitStatLocal?.(node) === false) {
		return;
	}

	for (const value of node.values) {
		visitExpression(value, visitor);
	}
}

function visitStatLocalFunction(node: AstStatLocalFunction, visitor: LuauVisitor): void {
	if (visitor.visitStatLocalFunction?.(node) === false) {
		return;
	}

	visitExprFunction(node.func, visitor);
}

function visitStatReturn(node: AstStatReturn, visitor: LuauVisitor): void {
	if (visitor.visitStatReturn?.(node) === false) {
		return;
	}

	for (const expression of node.list) {
		visitExpression(expression, visitor);
	}
}

function visitExprBinary(node: AstExprBinary, visitor: LuauVisitor): void {
	if (visitor.visitExprBinary?.(node) === false) {
		return;
	}

	visitExpression(node.left, visitor);
	visitExpression(node.right, visitor);
}

function visitExprCall(node: AstExprCall, visitor: LuauVisitor): void {
	if (visitor.visitExprCall?.(node) === false) {
		return;
	}

	visitExpression(node.func, visitor);
	for (const argument of node.args) {
		visitExpression(argument, visitor);
	}
}

function visitExprFunction(node: AstExprFunction, visitor: LuauVisitor): void {
	if (visitor.visitExprFunction?.(node) === false) {
		return;
	}

	visitStatBlock(node.body, visitor);
	visitor.visitExprFunctionEnd?.(node);
}

function visitExprGroup(node: AstExprGroup, visitor: LuauVisitor): void {
	if (visitor.visitExprGroup?.(node) === false) {
		return;
	}

	visitExpression(node.expr, visitor);
}

function visitExprIfElse(node: AstExprIfElse, visitor: LuauVisitor): void {
	if (visitor.visitExprIfElse?.(node) === false) {
		return;
	}

	visitExpression(node.condition, visitor);
	visitExpression(node.trueExpr, visitor);
	visitExpression(node.falseExpr, visitor);
}

function visitExprIndexExpr(node: AstExprIndexExpr, visitor: LuauVisitor): void {
	if (visitor.visitExprIndexExpr?.(node) === false) {
		return;
	}

	visitExpression(node.expr, visitor);
	visitExpression(node.index, visitor);
}

function visitExprIndexName(node: AstExprIndexName, visitor: LuauVisitor): void {
	if (visitor.visitExprIndexName?.(node) === false) {
		return;
	}

	visitExpression(node.expr, visitor);
}

function visitExprInterpString(node: AstExprInterpString, visitor: LuauVisitor): void {
	if (visitor.visitExprInterpString?.(node) === false) {
		return;
	}

	for (const expression of node.expressions) {
		visitExpression(expression, visitor);
	}
}

function visitExprTable(node: AstExprTable, visitor: LuauVisitor): void {
	if (visitor.visitExprTable?.(node) === false) {
		return;
	}

	for (const item of node.items) {
		if (visitor.visitTableItem?.(item) === false) {
			continue;
		}

		if (item.key !== undefined) {
			visitExpression(item.key, visitor);
		}

		visitExpression(item.value, visitor);
	}
}

function visitExprTypeAssertion(node: AstExprTypeAssertion, visitor: LuauVisitor): void {
	if (visitor.visitExprTypeAssertion?.(node) === false) {
		return;
	}

	visitExpression(node.expr, visitor);
}

function visitExprUnary(node: AstExprUnary, visitor: LuauVisitor): void {
	if (visitor.visitExprUnary?.(node) === false) {
		return;
	}

	visitExpression(node.expr, visitor);
}

function visitStatAssign(node: AstStatAssign, visitor: LuauVisitor): void {
	if (visitor.visitStatAssign?.(node) === false) {
		return;
	}

	for (const variable of node.vars) {
		visitExpression(variable, visitor);
	}

	for (const value of node.values) {
		visitExpression(value, visitor);
	}
}

function visitStatBlock(node: AstStatBlock, visitor: LuauVisitor): void {
	if (visitor.visitStatBlock?.(node) === false) {
		return;
	}

	for (const statement of node.body) {
		visitStatement(statement, visitor);
	}

	visitor.visitStatBlockEnd?.(node);
}

function visitStatFor(node: AstStatFor, visitor: LuauVisitor): void {
	if (visitor.visitStatFor?.(node) === false) {
		return;
	}

	visitExpression(node.from, visitor);
	visitExpression(node.to, visitor);
	if (node.step !== undefined) {
		visitExpression(node.step, visitor);
	}

	visitStatBlock(node.body, visitor);
}

function visitStatForIn(node: AstStatForIn, visitor: LuauVisitor): void {
	if (visitor.visitStatForIn?.(node) === false) {
		return;
	}

	for (const value of node.values) {
		visitExpression(value, visitor);
	}

	visitStatBlock(node.body, visitor);
}

function visitStatIf(node: AstStatIf, visitor: LuauVisitor): void {
	if (visitor.visitStatIf?.(node) === false) {
		return;
	}

	visitExpression(node.condition, visitor);
	visitStatBlock(node.thenbody, visitor);
	if (node.elsebody === undefined) {
		return;
	}

	if (node.elsebody.type === "AstStatIf") {
		visitStatIf(node.elsebody, visitor);
	} else {
		visitStatBlock(node.elsebody, visitor);
	}
}

function visitStatRepeat(node: AstStatRepeat, visitor: LuauVisitor): void {
	if (visitor.visitStatRepeat?.(node) === false) {
		return;
	}

	visitStatBlock(node.body, visitor);
	visitExpression(node.condition, visitor);
}

function visitStatWhile(node: AstStatWhile, visitor: LuauVisitor): void {
	if (visitor.visitStatWhile?.(node) === false) {
		return;
	}

	visitExpression(node.condition, visitor);
	visitStatBlock(node.body, visitor);
}
