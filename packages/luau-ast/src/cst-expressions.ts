/**
 * Expression nodes of the concrete syntax tree. Slots are listed here in
 * alphabetical order; the serializer emits them in lexical order, which is
 * the order a walk over a node's values visits them.
 */

import type { LuauSpan } from "./ast.ts";
import type { CstBlock } from "./cst-statements.ts";
import type { Token } from "./cst-token.ts";

/** One entry of a separated list; the separator is absent on the last one. */
export interface Punctuated<T> {
	node: T;
	separator?: Token;
}

export interface CstNodeBase<Kind extends string> {
	location: LuauSpan;
	type: Kind;
}

/** A node that is one token: literals, `...`, `break`, `continue`. */
export interface CstTokenNode<Kind extends string> extends CstNodeBase<Kind> {
	token: Token;
}

/**
 * A construct the serializer does not model yet: one token over its span.
 * `kind` names the Luau node behind the slice, for diagnostics only.
 */
export interface CstRaw extends CstNodeBase<"Raw"> {
	kind: string;
	token: Token;
}

/**
 * A binding declaration. `binding` is shared with every {@link CstLocalRef}
 * of the same local and unique to the declaration site.
 */
export interface CstLocalDeclaration extends CstNodeBase<"LocalDecl"> {
	name: Token;
	annotation?: CstRaw;
	binding: number;
	colon?: Token;
}

export interface CstGenerics extends CstNodeBase<"Generics"> {
	close: Token;
	items: Array<Punctuated<CstRaw>>;
	open: Token;
}

/** `<<A, B>>` on a call or a bare instantiation. */
export interface CstTypeArguments extends CstNodeBase<"TypeArguments"> {
	close1: Token;
	close2: Token;
	items: Array<Punctuated<CstRaw>>;
	open1: Token;
	open2: Token;
}

export interface CstGroup extends CstNodeBase<"Group"> {
	close: Token;
	expr: CstExpr;
	open: Token;
}

export type CstNil = CstTokenNode<"Nil">;
export type CstBool = CstTokenNode<"Bool">;
export type CstNumber = CstTokenNode<"Number">;
export type CstString = CstTokenNode<"String">;
export type CstVarargs = CstTokenNode<"Varargs">;

/** A reference to a local; `binding` matches its declaration. */
export interface CstLocalRef extends CstNodeBase<"LocalRef"> {
	name: Token;
	binding: number;
}

export interface CstGlobal extends CstNodeBase<"Global"> {
	name: Token;
}

/** `open` and `close` are absent on `f"s"` and `f{}` calls. */
export interface CstCall extends CstNodeBase<"Call"> {
	arguments: Array<Punctuated<CstExpr>>;
	callee: CstExpr;
	close?: Token;
	open?: Token;
	typeArguments?: CstTypeArguments;
}

export interface CstIndexName extends CstNodeBase<"IndexName"> {
	expr: CstExpr;
	index: Token;
	operator: Token;
}

export interface CstIndexExpr extends CstNodeBase<"IndexExpr"> {
	close: Token;
	expr: CstExpr;
	index: CstExpr;
	open: Token;
}

/** Everything after `function` (and, for statements, the name). */
export interface CstFunctionBody extends CstNodeBase<"FunctionBody"> {
	block: CstBlock;
	close: Token;
	end: Token;
	generics?: CstGenerics;
	open: Token;
	parameters: Array<Punctuated<CstLocalDeclaration>>;
	returnColon?: Token;
	returnType?: CstRaw;
	vararg?: Token;
	varargAnnotation?: CstRaw;
	varargColon?: Token;
}

export interface CstFunctionExpr extends CstNodeBase<"FunctionExpr"> {
	attributes?: Array<CstRaw>;
	body: CstFunctionBody;
	keyword: Token;
}

export interface CstTableItem extends CstNodeBase<"TableItem"> {
	key?: CstExpr;
	close?: Token;
	equals?: Token;
	open?: Token;
	separator?: Token;
	value: CstExpr;
}

export interface CstTable extends CstNodeBase<"Table"> {
	close: Token;
	items: Array<CstTableItem>;
	open: Token;
}

export interface CstUnary extends CstNodeBase<"Unary"> {
	expr: CstExpr;
	operator: Token;
}

export interface CstBinary extends CstNodeBase<"Binary"> {
	left: CstExpr;
	operator: Token;
	right: CstExpr;
}

export interface CstTypeAssertion extends CstNodeBase<"TypeAssertion"> {
	annotation: CstRaw;
	expr: CstExpr;
	operator: Token;
}

export interface CstElseIfExpr extends CstNodeBase<"ElseIfExpr"> {
	condition: CstExpr;
	keyword: Token;
	then?: Token;
	trueExpr: CstExpr;
}

export interface CstIfElse extends CstNodeBase<"IfElse"> {
	condition: CstExpr;
	else?: Token;
	elseifs: Array<CstElseIfExpr>;
	falseExpr?: CstExpr;
	if: Token;
	then?: Token;
	trueExpr: CstExpr;
}

/**
 * Alternating string segments and expressions. A segment token carries its
 * delimiters and the whitespace inside the braces, so the parts tile the
 * literal.
 */
export interface CstInterpString extends CstNodeBase<"InterpString"> {
	parts: Array<CstExpr | Token>;
}

export interface CstInstantiate extends CstNodeBase<"Instantiate"> {
	expr: CstExpr;
	typeArguments: CstTypeArguments;
}

export type CstExpr =
	| CstBinary
	| CstBool
	| CstCall
	| CstFunctionExpr
	| CstGlobal
	| CstGroup
	| CstIfElse
	| CstIndexExpr
	| CstIndexName
	| CstInstantiate
	| CstInterpString
	| CstLocalRef
	| CstNil
	| CstNumber
	| CstString
	| CstTable
	| CstTypeAssertion
	| CstUnary
	| CstVarargs;
