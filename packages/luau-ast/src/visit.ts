/* eslint-disable max-lines -- Visitor pattern is inherently verbose. */
/**
 * Visitor over the official parser's AST (see ast-types.ts). Each enter
 * callback returns boolean — false skips the node's children. All callbacks
 * optional, default true. Type-annotation nodes are not visited.
 */
import type * as Ast from "./ast-types.ts";

/** Callbacks controlling AST descent and observing completed nodes. */
export interface LuauVisitor {
	/** Called before descending into Ast.AstExpr; false skips its children. */
	visitExpr?: (node: Ast.AstExpr) => boolean;
	/**
	 * Called before descending into Ast.AstExprBinary; false skips its
	 * children.
	 */
	visitExprBinary?: (node: Ast.AstExprBinary) => boolean;
	/**
	 * Called before descending into Ast.AstExprCall; false skips its children.
	 */
	visitExprCall?: (node: Ast.AstExprCall) => boolean;
	/**
	 * Called before descending into Ast.AstExprConstantBool; false skips its
	 * children.
	 */
	visitExprConstantBool?: (node: Ast.AstExprConstantBool) => boolean;
	/**
	 * Called before descending into Ast.AstExprConstantNil; false skips its
	 * children.
	 */
	visitExprConstantNil?: (node: Ast.AstExprConstantNil) => boolean;
	/**
	 * Called before descending into Ast.AstExprConstantNumber; false skips its
	 * children.
	 */
	visitExprConstantNumber?: (node: Ast.AstExprConstantNumber) => boolean;
	/**
	 * Called before descending into Ast.AstExprConstantString; false skips its
	 * children.
	 */
	visitExprConstantString?: (node: Ast.AstExprConstantString) => boolean;
	/** Called after the children of Ast.AstExpr have been visited. */
	visitExprEnd?: (node: Ast.AstExpr) => void;
	/**
	 * Called before descending into Ast.AstExprFunction; false skips its
	 * children.
	 */
	visitExprFunction?: (node: Ast.AstExprFunction) => boolean;
	/** Called after the children of Ast.AstExprFunction have been visited. */
	visitExprFunctionEnd?: (node: Ast.AstExprFunction) => void;
	/**
	 * Called before descending into Ast.AstExprGlobal; false skips its
	 * children.
	 */
	visitExprGlobal?: (node: Ast.AstExprGlobal) => boolean;
	/**
	 * Called before descending into Ast.AstExprGroup; false skips its
	 * children.
	 */
	visitExprGroup?: (node: Ast.AstExprGroup) => boolean;
	/**
	 * Called before descending into Ast.AstExprIfElse; false skips its
	 * children.
	 */
	visitExprIfElse?: (node: Ast.AstExprIfElse) => boolean;
	/**
	 * Called before descending into Ast.AstExprIndexExpr; false skips its
	 * children.
	 */
	visitExprIndexExpr?: (node: Ast.AstExprIndexExpr) => boolean;
	/**
	 * Called before descending into Ast.AstExprIndexName; false skips its
	 * children.
	 */
	visitExprIndexName?: (node: Ast.AstExprIndexName) => boolean;
	/**
	 * Called before descending into Ast.AstExprInstantiate; false skips its
	 * children.
	 */
	visitExprInstantiate?: (node: Ast.AstExprInstantiate) => boolean;
	/**
	 * Called before descending into Ast.AstExprInterpString; false skips its
	 * children.
	 */
	visitExprInterpString?: (node: Ast.AstExprInterpString) => boolean;
	/**
	 * Called before descending into Ast.AstExprLocal; false skips its
	 * children.
	 */
	visitExprLocal?: (node: Ast.AstExprLocal) => boolean;
	/**
	 * Called before descending into Ast.AstExprTable; false skips its
	 * children.
	 */
	visitExprTable?: (node: Ast.AstExprTable) => boolean;
	/**
	 * Called before descending into Ast.AstExprTypeAssertion; false skips its
	 * children.
	 */
	visitExprTypeAssertion?: (node: Ast.AstExprTypeAssertion) => boolean;
	/**
	 * Called before descending into Ast.AstExprUnary; false skips its
	 * children.
	 */
	visitExprUnary?: (node: Ast.AstExprUnary) => boolean;
	/**
	 * Called before descending into Ast.AstExprVarargs; false skips its
	 * children.
	 */
	visitExprVarargs?: (node: Ast.AstExprVarargs) => boolean;

	/**
	 * Called before descending into Ast.AstStatAssign; false skips its
	 * children.
	 */
	visitStatAssign?: (node: Ast.AstStatAssign) => boolean;
	/**
	 * Called before descending into Ast.AstStatBlock; false skips its
	 * children.
	 */
	visitStatBlock?: (node: Ast.AstStatBlock) => boolean;
	/** Called after the children of Ast.AstStatBlock have been visited. */
	visitStatBlockEnd?: (node: Ast.AstStatBlock) => void;
	/**
	 * Called before descending into Ast.AstStatBreak; false skips its
	 * children.
	 */
	visitStatBreak?: (node: Ast.AstStatBreak) => boolean;
	/**
	 * Called before descending into Ast.AstStatCompoundAssign; false skips its
	 * children.
	 */
	visitStatCompoundAssign?: (node: Ast.AstStatCompoundAssign) => boolean;
	/**
	 * Called before descending into Ast.AstStatContinue; false skips its
	 * children.
	 */
	visitStatContinue?: (node: Ast.AstStatContinue) => boolean;
	/**
	 * Called before descending into Ast.AstStatExpr; false skips its children.
	 */
	visitStatExpr?: (node: Ast.AstStatExpr) => boolean;
	/**
	 * Called before descending into Ast.AstStatFor; false skips its children.
	 */
	visitStatFor?: (node: Ast.AstStatFor) => boolean;
	/**
	 * Called before descending into Ast.AstStatForIn; false skips its
	 * children.
	 */
	visitStatForIn?: (node: Ast.AstStatForIn) => boolean;
	/**
	 * Called before descending into Ast.AstStatFunction; false skips its
	 * children.
	 */
	visitStatFunction?: (node: Ast.AstStatFunction) => boolean;
	/**
	 * Called before descending into Ast.AstStatIf; false skips its children.
	 */
	visitStatIf?: (node: Ast.AstStatIf) => boolean;
	/**
	 * Called before descending into Ast.AstStatLocal; false skips its
	 * children.
	 */
	visitStatLocal?: (node: Ast.AstStatLocal) => boolean;
	/**
	 * Called before descending into Ast.AstStatLocalFunction; false skips its
	 * children.
	 */
	visitStatLocalFunction?: (node: Ast.AstStatLocalFunction) => boolean;
	/**
	 * Called before descending into Ast.AstStatRepeat; false skips its
	 * children.
	 */
	visitStatRepeat?: (node: Ast.AstStatRepeat) => boolean;
	/**
	 * Called before descending into Ast.AstStatReturn; false skips its
	 * children.
	 */
	visitStatReturn?: (node: Ast.AstStatReturn) => boolean;
	/**
	 * Called before descending into Ast.AstStatTypeAlias; false skips its
	 * children.
	 */
	visitStatTypeAlias?: (node: Ast.AstStatTypeAlias) => boolean;
	/**
	 * Called before descending into Ast.AstStatWhile; false skips its
	 * children.
	 */
	visitStatWhile?: (node: Ast.AstStatWhile) => boolean;

	/**
	 * Called before descending into Ast.AstExprTableItem; false skips its
	 * children.
	 */
	visitTableItem?: (node: Ast.AstExprTableItem) => boolean;
}

/**
 * Visit a block and its statements using the supplied callbacks.
 * @param block - The AST block whose statements are visited.
 * @param visitor - The callbacks controlling descent through the AST.
 */
export function visitBlock(block: Ast.AstStatBlock, visitor: LuauVisitor): void {
	visitStatBlock(block, visitor);
}

/**
 * Visit an expression, skipping children when an enter callback returns false.
 * @param expression - The AST expression whose children are visited.
 * @param visitor - The callbacks controlling descent through the AST.
 */
// eslint-disable-next-line flawless/max-lines-per-function -- Exhaustive visitor dispatch follows the AST union.
export function visitExpression(expression: Ast.AstExpr, visitor: LuauVisitor): void {
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
		case "AstExprInstantiate": {
			visitExprInstantiate(expression, visitor);
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

/**
 * Visit a statement, skipping children when its callback returns false.
 * @param statement - The AST statement whose children are visited.
 * @param visitor - The callbacks controlling descent through the AST.
 */
// eslint-disable-next-line flawless/max-lines-per-function -- Exhaustive visitor dispatch follows the AST union.
export function visitStatement(statement: Ast.AstStat, visitor: LuauVisitor): void {
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

function visitStatCompoundAssign(node: Ast.AstStatCompoundAssign, visitor: LuauVisitor): void {
	if (visitor.visitStatCompoundAssign?.(node) === false) {
		return;
	}

	visitExpression(node.var, visitor);
	visitExpression(node.value, visitor);
}

function visitStatExpr(node: Ast.AstStatExpr, visitor: LuauVisitor): void {
	if (visitor.visitStatExpr?.(node) === false) {
		return;
	}

	visitExpression(node.expr, visitor);
}

function visitStatFunction(node: Ast.AstStatFunction, visitor: LuauVisitor): void {
	if (visitor.visitStatFunction?.(node) === false) {
		return;
	}

	visitExpression(node.name, visitor);
	visitExprFunction(node.func, visitor);
}

function visitStatLocal(node: Ast.AstStatLocal, visitor: LuauVisitor): void {
	if (visitor.visitStatLocal?.(node) === false) {
		return;
	}

	for (const value of node.values) {
		visitExpression(value, visitor);
	}
}

function visitStatLocalFunction(node: Ast.AstStatLocalFunction, visitor: LuauVisitor): void {
	if (visitor.visitStatLocalFunction?.(node) === false) {
		return;
	}

	visitExprFunction(node.func, visitor);
}

function visitStatReturn(node: Ast.AstStatReturn, visitor: LuauVisitor): void {
	if (visitor.visitStatReturn?.(node) === false) {
		return;
	}

	for (const expression of node.list) {
		visitExpression(expression, visitor);
	}
}

function visitExprBinary(node: Ast.AstExprBinary, visitor: LuauVisitor): void {
	if (visitor.visitExprBinary?.(node) === false) {
		return;
	}

	visitExpression(node.left, visitor);
	visitExpression(node.right, visitor);
}

function visitExprCall(node: Ast.AstExprCall, visitor: LuauVisitor): void {
	if (visitor.visitExprCall?.(node) === false) {
		return;
	}

	visitExpression(node.func, visitor);
	for (const argument of node.args) {
		visitExpression(argument, visitor);
	}
}

function visitExprFunction(node: Ast.AstExprFunction, visitor: LuauVisitor): void {
	if (visitor.visitExprFunction?.(node) === false) {
		return;
	}

	visitStatBlock(node.body, visitor);
	visitor.visitExprFunctionEnd?.(node);
}

function visitExprGroup(node: Ast.AstExprGroup, visitor: LuauVisitor): void {
	if (visitor.visitExprGroup?.(node) === false) {
		return;
	}

	visitExpression(node.expr, visitor);
}

function visitExprIfElse(node: Ast.AstExprIfElse, visitor: LuauVisitor): void {
	if (visitor.visitExprIfElse?.(node) === false) {
		return;
	}

	visitExpression(node.condition, visitor);
	visitExpression(node.trueExpr, visitor);
	visitExpression(node.falseExpr, visitor);
}

function visitExprIndexExpr(node: Ast.AstExprIndexExpr, visitor: LuauVisitor): void {
	if (visitor.visitExprIndexExpr?.(node) === false) {
		return;
	}

	visitExpression(node.expr, visitor);
	visitExpression(node.index, visitor);
}

function visitExprIndexName(node: Ast.AstExprIndexName, visitor: LuauVisitor): void {
	if (visitor.visitExprIndexName?.(node) === false) {
		return;
	}

	visitExpression(node.expr, visitor);
}

function visitExprInstantiate(node: Ast.AstExprInstantiate, visitor: LuauVisitor): void {
	if (visitor.visitExprInstantiate?.(node) === false) {
		return;
	}

	visitExpression(node.expr, visitor);
}

function visitExprInterpString(node: Ast.AstExprInterpString, visitor: LuauVisitor): void {
	if (visitor.visitExprInterpString?.(node) === false) {
		return;
	}

	for (const expression of node.expressions) {
		visitExpression(expression, visitor);
	}
}

function visitExprTable(node: Ast.AstExprTable, visitor: LuauVisitor): void {
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

function visitExprTypeAssertion(node: Ast.AstExprTypeAssertion, visitor: LuauVisitor): void {
	if (visitor.visitExprTypeAssertion?.(node) === false) {
		return;
	}

	visitExpression(node.expr, visitor);
}

function visitExprUnary(node: Ast.AstExprUnary, visitor: LuauVisitor): void {
	if (visitor.visitExprUnary?.(node) === false) {
		return;
	}

	visitExpression(node.expr, visitor);
}

function visitStatAssign(node: Ast.AstStatAssign, visitor: LuauVisitor): void {
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

function visitStatBlock(node: Ast.AstStatBlock, visitor: LuauVisitor): void {
	if (visitor.visitStatBlock?.(node) === false) {
		return;
	}

	for (const statement of node.body) {
		visitStatement(statement, visitor);
	}

	visitor.visitStatBlockEnd?.(node);
}

function visitStatFor(node: Ast.AstStatFor, visitor: LuauVisitor): void {
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

function visitStatForIn(node: Ast.AstStatForIn, visitor: LuauVisitor): void {
	if (visitor.visitStatForIn?.(node) === false) {
		return;
	}

	for (const value of node.values) {
		visitExpression(value, visitor);
	}

	visitStatBlock(node.body, visitor);
}

function visitStatIf(node: Ast.AstStatIf, visitor: LuauVisitor): void {
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

function visitStatRepeat(node: Ast.AstStatRepeat, visitor: LuauVisitor): void {
	if (visitor.visitStatRepeat?.(node) === false) {
		return;
	}

	visitStatBlock(node.body, visitor);
	visitExpression(node.condition, visitor);
}

function visitStatWhile(node: Ast.AstStatWhile, visitor: LuauVisitor): void {
	if (visitor.visitStatWhile?.(node) === false) {
		return;
	}

	visitExpression(node.condition, visitor);
	visitStatBlock(node.body, visitor);
}
