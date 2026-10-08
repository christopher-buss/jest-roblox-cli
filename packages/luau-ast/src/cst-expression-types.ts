/**
 * Expression nodes of the concrete syntax tree. Slots are listed here in
 * alphabetical order; `CST_SLOTS` holds the lexical order walks visit them in.
 */

import type { LuauSpan } from "./ast-types.ts";
import type { CstBlock } from "./cst-statement-types.ts";
import type { Token } from "./cst-token.ts";
import type { CstAttributes, CstGenerics, CstType, CstTypePack } from "./cst-types.ts";

/**
 * One entry of a separated list; the separator is absent on the last one.
 * @template T - Element stored alongside its separator.
 */
export interface Punctuated<T> {
	/** Element paired with this separator. */
	node: T;
	/** Separator token, absent when the entry has none. */
	separator?: Token;
}

/**
 * A concrete node kind and its source span.
 * @template Kind - Discriminant identifying this concrete node.
 */
export interface CstNodeBase<Kind extends string> {
	/** Source span with 1-based lines and UTF-8 byte columns. */
	location: LuauSpan;
	/** Node kind used to discriminate the tree union. */
	type: Kind;
}

/**
 * A node that is one token: literals, `...`, `break`, `continue`.
 * @template Kind - Discriminant identifying this token node.
 */
export interface CstTokenNode<Kind extends string> extends CstNodeBase<Kind> {
	/** Source token represented by this node. */
	token: Token;
}

/**
 * A binding declaration. `binding` is shared with every {@link CstLocalRef}
 * of the same local and unique to the declaration site.
 */
export interface CstLocalDeclaration extends CstNodeBase<"LocalDecl"> {
	/** Name token introducing this local binding. */
	name: Token;
	/** Type annotation attached to the expression or declaration. */
	annotation?: CstType;
	/**
	 * Binding identifier shared by the declaration and its references.
	 */
	binding: number;
	/** Colon introducing the type annotation. */
	colon?: Token;
}

/** `<<A, B>>` on a call or a bare instantiation. */
export interface CstTypeArguments extends CstNodeBase<"TypeArguments"> {
	/** First closing angle bracket of the type argument list. */
	close1: Token;
	/** Second closing angle bracket of the type argument list. */
	close2: Token;
	/** Entries in source order. */
	items: Array<Punctuated<CstType | CstTypePack>>;
	/** First opening angle bracket of the type argument list. */
	open1: Token;
	/** Second opening angle bracket of the type argument list. */
	open2: Token;
}

/** A parenthesized expression with both delimiters. */
export interface CstGroup extends CstNodeBase<"Group"> {
	/** Closing delimiter token. */
	close: Token;
	/** Expression inside the parentheses. */
	expr: CstExpr;
	/** Opening delimiter token. */
	open: Token;
}

/** The nil literal and its source token. */
export type CstNil = CstTokenNode<"Nil">;
/** A boolean literal and its source token. */
export type CstBool = CstTokenNode<"Bool">;
/** A numeric literal and its source token. */
export type CstNumber = CstTokenNode<"Number">;
/** A string literal retaining its source spelling. */
export type CstString = CstTokenNode<"String">;
/** The variadic argument token `...`. */
export type CstVarargs = CstTokenNode<"Varargs">;

/** A reference to a local; `binding` matches its declaration. */
export interface CstLocalRef extends CstNodeBase<"LocalRef"> {
	/** Name token referencing the resolved local binding. */
	name: Token;
	/**
	 * Binding identifier shared by the declaration and its references.
	 */
	binding: number;
}

/** A global name reference retaining its source token. */
export interface CstGlobal extends CstNodeBase<"Global"> {
	/** Name token referencing an unresolved global. */
	name: Token;
}

/** `open` and `close` are absent on `f"s"` and `f{}` calls. */
export interface CstCall extends CstNodeBase<"Call"> {
	/** Call arguments paired with their trailing separators. */
	arguments: Array<Punctuated<CstExpr>>;
	/** Expression whose value is called. */
	callee: CstExpr;
	/** Closing delimiter token. */
	close?: Token;
	/** Opening delimiter token. */
	open?: Token;
	/** Explicit type arguments supplied to the expression. */
	typeArguments?: CstTypeArguments;
}

/** A named field or method access. */
export interface CstIndexName extends CstNodeBase<"IndexName"> {
	/** Expression producing the value whose member is accessed. */
	expr: CstExpr;
	/** Literal field or method name token. */
	index: Token;
	/** Dot for field access or colon for method access. */
	operator: Token;
}

/** A bracketed index expression. */
export interface CstIndexExpr extends CstNodeBase<"IndexExpr"> {
	/** Closing delimiter token. */
	close: Token;
	/** Expression producing the indexed value. */
	expr: CstExpr;
	/** Expression producing the index key. */
	index: CstExpr;
	/** Opening delimiter token. */
	open: Token;
}

/**
 * `(a, ...: T): R`; a function body, a `declare function`, or a method.
 * @template Parameter - Binding or typed argument stored in the signature.
 */
export interface CstSignature<Parameter> {
	/** Closing delimiter token. */
	close: Token;
	/** Opening delimiter token. */
	open: Token;
	/** Parameters in source order, each with its separator. */
	parameters: Array<Punctuated<Parameter>>;
	/** Colon introducing the return annotation. */
	returnColon?: Token;
	/** Return type pack, absent on an unannotated signature. */
	returnType?: CstTypePack;
	/** Ellipsis token marking a variadic parameter. */
	vararg?: Token;
	/** Type annotation for the variadic parameter when present. */
	varargAnnotation?: CstTypePack;
	/** Colon introducing the variadic parameter annotation. */
	varargColon?: Token;
}

/** Everything after `function` (and, for statements, the name). */
export interface CstFunctionBody
	extends CstNodeBase<"FunctionBody">, CstSignature<CstLocalDeclaration> {
	/** Statements in the function body. */
	block: CstBlock;
	/** End keyword closing the construct. */
	end: Token;
	/** Generic type parameters attached to the declaration. */
	generics?: CstGenerics;
}

/** A function expression with its keyword and body. */
export interface CstFunctionExpr extends CstNodeBase<"FunctionExpr"> {
	/** Attributes attached to the declaration. */
	attributes?: CstAttributes;
	/** Function signature and body following the keyword. */
	body: CstFunctionBody;
	/** Function keyword introducing the expression. */
	keyword: Token;
}

/** A positional, named, or bracketed table constructor entry. */
export interface CstTableItem extends CstNodeBase<"TableItem"> {
	/** Key expression, absent for a positional entry. */
	key?: CstExpr;
	/** Closing delimiter token. */
	close?: Token;
	/** Equals token introducing the assigned value or initializer. */
	equals?: Token;
	/** Opening delimiter token. */
	open?: Token;
	/** Separator token, absent when the entry has none. */
	separator?: Token;
	/** Expression supplying the table entry value. */
	value: CstExpr;
}

/** A table constructor retaining its braces and entries. */
export interface CstTable extends CstNodeBase<"Table"> {
	/** Closing delimiter token. */
	close: Token;
	/** Entries in source order. */
	items: Array<CstTableItem>;
	/** Opening delimiter token. */
	open: Token;
}

/** A unary expression retaining its operator token. */
export interface CstUnary extends CstNodeBase<"Unary"> {
	/** Operand of the unary operator. */
	expr: CstExpr;
	/** Operator token connecting this node to its operand or target. */
	operator: Token;
}

/** A binary expression retaining its operator token. */
export interface CstBinary extends CstNodeBase<"Binary"> {
	/** Left operand of the binary expression. */
	left: CstExpr;
	/** Operator token connecting this node to its operand or target. */
	operator: Token;
	/** Right operand of the binary expression. */
	right: CstExpr;
}

/** A type assertion retaining the `::` operator. */
export interface CstTypeAssertion extends CstNodeBase<"TypeAssertion"> {
	/** Type annotation attached to the expression or declaration. */
	annotation: CstType;
	/** Expression whose type is asserted. */
	expr: CstExpr;
	/** Double-colon token introducing the type assertion. */
	operator: Token;
}

/** An elseif branch of a conditional expression. */
export interface CstElseIfExpr extends CstNodeBase<"ElseIfExpr"> {
	/** Expression selecting a branch or controlling a loop. */
	condition: CstExpr;
	/** Equals token introducing the assigned value or initializer. */
	equals?: Token;
	/** Keyword introducing this construct. */
	keyword: Token;
	/** Conditional binding visible only in the true expression. */
	local?: CstLocalDeclaration;
	/** Local or const keyword introducing a conditional binding. */
	localKeyword?: Token;
	/** Then keyword when recorded by the parser. */
	then?: Token;
	/** Expression evaluated when the condition is true. */
	trueExpr: CstExpr;
}

/** A conditional expression retaining its branch keywords. */
export interface CstIfElse extends CstNodeBase<"IfElse"> {
	/** Expression selecting a branch or controlling a loop. */
	condition: CstExpr;
	/** Else keyword when the alternate branch is present. */
	else?: Token;
	/** Elseif branches in source order. */
	elseifs: Array<CstElseIfExpr>;
	/** Equals token introducing the assigned value or initializer. */
	equals?: Token;
	/** Expression evaluated when the condition is false. */
	falseExpr?: CstExpr;
	/** If keyword introducing the first branch. */
	if: Token;
	/** Conditional binding visible only in the true expression. */
	local?: CstLocalDeclaration;
	/** Local or const keyword introducing a conditional binding. */
	localKeyword?: Token;
	/** Then keyword when recorded by the parser. */
	then?: Token;
	/** Expression evaluated when the condition is true. */
	trueExpr: CstExpr;
}

/**
 * Alternating string segments and expressions. A segment token carries its
 * delimiters and the whitespace inside the braces, so the parts tile the
 * literal.
 */
export interface CstInterpString extends CstNodeBase<"InterpString"> {
	/** Alternating literal segment tokens and embedded expressions. */
	parts: Array<CstExpr | Token>;
}

/** An expression with explicit type arguments. */
export interface CstInstantiate extends CstNodeBase<"Instantiate"> {
	/** Expression receiving the explicit type arguments. */
	expr: CstExpr;
	/** Explicit type arguments supplied to the expression. */
	typeArguments: CstTypeArguments;
}

/** Every expression kind in the concrete syntax tree. */
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
