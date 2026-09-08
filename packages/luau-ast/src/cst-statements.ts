/**
 * Statement nodes of the concrete syntax tree. Every statement may end in a
 * `semicolon` token.
 */

import type {
	CstExpr,
	CstFunctionBody,
	CstLocalDeclaration,
	CstNodeBase,
	CstSignature,
	CstTokenNode,
	Punctuated,
} from "./cst-expressions.ts";
import type { Token } from "./cst-token.ts";
import type {
	CstAttributes,
	CstFunctionTypeArgument,
	CstGenerics,
	CstType,
	CstTypeTableItem,
} from "./cst-types.ts";

export interface CstStatBase<Kind extends string> extends CstNodeBase<Kind> {
	semicolon?: Token;
}

export interface CstBlock extends CstNodeBase<"Block"> {
	body: Array<CstStat>;
}

export interface CstDo extends CstStatBase<"Do"> {
	body: CstBlock;
	do: Token;
	end: Token;
}

export interface CstElseIf extends CstNodeBase<"ElseIf"> {
	body: CstBlock;
	condition: CstExpr;
	keyword: Token;
	then?: Token;
}

export interface CstIf extends CstStatBase<"If"> {
	body: CstBlock;
	condition: CstExpr;
	else?: Token;
	elseBody?: CstBlock;
	elseifs: Array<CstElseIf>;
	end: Token;
	if: Token;
	then?: Token;
}

export interface CstWhile extends CstStatBase<"While"> {
	body: CstBlock;
	condition: CstExpr;
	do?: Token;
	end: Token;
	while: Token;
}

export interface CstRepeat extends CstStatBase<"Repeat"> {
	body: CstBlock;
	condition: CstExpr;
	repeat: Token;
	until: Token;
}

export interface CstBreak extends CstStatBase<"Break">, CstTokenNode<"Break"> {}

export interface CstContinue extends CstStatBase<"Continue">, CstTokenNode<"Continue"> {}

export interface CstReturn extends CstStatBase<"Return"> {
	keyword: Token;
	values: Array<Punctuated<CstExpr>>;
}

export interface CstExprStat extends CstStatBase<"ExprStat"> {
	expr: CstExpr;
}

/** `keyword` is `local` or `const`. */
export interface CstLocal extends CstStatBase<"Local"> {
	equals?: Token;
	export?: Token;
	keyword: Token;
	values: Array<Punctuated<CstExpr>>;
	variables: Array<Punctuated<CstLocalDeclaration>>;
}

export interface CstFor extends CstStatBase<"For"> {
	body: CstBlock;
	do?: Token;
	end: Token;
	equals: Token;
	for: Token;
	from: CstExpr;
	fromComma: Token;
	step?: CstExpr;
	to: CstExpr;
	toComma?: Token;
	variable: CstLocalDeclaration;
}

export interface CstForIn extends CstStatBase<"ForIn"> {
	body: CstBlock;
	do?: Token;
	end: Token;
	for: Token;
	in?: Token;
	values: Array<Punctuated<CstExpr>>;
	variables: Array<Punctuated<CstLocalDeclaration>>;
}

export interface CstAssign extends CstStatBase<"Assign"> {
	equals: Token;
	values: Array<Punctuated<CstExpr>>;
	variables: Array<Punctuated<CstExpr>>;
}

export interface CstCompoundAssign extends CstStatBase<"CompoundAssign"> {
	operator: Token;
	value: CstExpr;
	variable: CstExpr;
}

export interface CstFunctionStat extends CstStatBase<"FunctionStat"> {
	name: CstExpr;
	attributes?: CstAttributes;
	body: CstFunctionBody;
	keyword: Token;
}

/**
 * `local` is `local` or `const`; `export function f` carries `export` instead.
 */
export interface CstLocalFunction extends CstStatBase<"LocalFunction"> {
	name: CstLocalDeclaration;
	attributes?: CstAttributes;
	body: CstFunctionBody;
	export?: Token;
	keyword: Token;
	local?: Token;
}

export interface CstTypeAlias extends CstStatBase<"TypeAlias"> {
	name: Token;
	equals: Token;
	export?: Token;
	generics?: CstGenerics;
	keyword: Token;
	value: CstType;
}

/** `type function Name(...) ... end` */
export interface CstTypeFunctionStat extends CstStatBase<"TypeFunctionStat"> {
	name: Token;
	body: CstFunctionBody;
	export?: Token;
	function: Token;
	keyword: Token;
}

/** `declare name: T` */
export interface CstDeclareGlobal extends CstStatBase<"DeclareGlobal"> {
	name: Token;
	annotation: CstType;
	colon: Token;
	declare: Token;
}

export interface CstDeclareFunction
	extends CstSignature<CstFunctionTypeArgument>, CstStatBase<"DeclareFunction"> {
	name: Token;
	attributes?: CstAttributes;
	declare: Token;
	function: Token;
	generics?: CstGenerics;
}

/** A method's `self` is its first parameter. */
export interface CstExternTypeMethod
	extends CstNodeBase<"ExternTypeMethod">, CstSignature<CstFunctionTypeArgument> {
	name: Token;
	attributes?: CstAttributes;
	function: Token;
}

/** `declare extern type Name [extends Super] with ... end` */
export interface CstDeclareExternType extends CstStatBase<"DeclareExternType"> {
	name: Token;
	declare: Token;
	end: Token;
	extends?: Token;
	extern: Token;
	keyword: Token;
	members: Array<CstExternTypeMethod | CstTypeTableItem>;
	super?: Token;
	with: Token;
}

export type CstStat =
	| CstAssign
	| CstBreak
	| CstCompoundAssign
	| CstContinue
	| CstDeclareExternType
	| CstDeclareFunction
	| CstDeclareGlobal
	| CstDo
	| CstExprStat
	| CstFor
	| CstForIn
	| CstFunctionStat
	| CstIf
	| CstLocal
	| CstLocalFunction
	| CstRepeat
	| CstReturn
	| CstTypeAlias
	| CstTypeFunctionStat
	| CstWhile;

/**
 * `eof` is an empty token at the end of the source; its leading trivia is
 * the file's tail.
 */
export interface CstRoot extends CstNodeBase<"Root"> {
	body: CstBlock;
	eof: Token;
}
