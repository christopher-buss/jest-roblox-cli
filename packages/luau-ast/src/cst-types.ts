/**
 * Type-level nodes of the concrete syntax tree: type annotations, type
 * packs, generics, and attributes. Slots are listed in alphabetical order;
 * the serializer emits them in lexical order.
 */

import type {
	CstExpr,
	CstGlobal,
	CstLocalRef,
	CstNodeBase,
	CstTokenNode,
	Punctuated,
} from "./cst-expressions.ts";
import type { Token } from "./cst-token.ts";

/**
 * A named or qualified type, with its arguments when it has any. The
 * prefix of a qualified name is a name expression, so a prefix that
 * resolves to a local carries the local's binding.
 */
export interface CstTypeReference extends CstNodeBase<"TypeReference"> {
	name: Token;
	arguments?: Array<Punctuated<CstType | CstTypePack>>;
	close?: Token;
	dot?: Token;
	open?: Token;
	prefix?: CstGlobal | CstLocalRef;
}

/**
 * One member of a table type or an extern type body: a property (`name`,
 * with `open` and `close` when it is written `["name"]`), an indexer
 * (`key`), or the element type of an array-like `{ T }` (`value` alone).
 */
export interface CstTypeTableItem extends CstNodeBase<"TypeTableItem"> {
	key?: CstType;
	name?: Token;
	/** `read` or `write`. */
	access?: Token;
	close?: Token;
	colon?: Token;
	open?: Token;
	separator?: Token;
	value: CstType;
}

export interface CstTypeTable extends CstNodeBase<"TypeTable"> {
	close: Token;
	items: Array<CstTypeTableItem>;
	open: Token;
}

/**
 * A parameter of a function type or a `declare` signature. A function
 * type's parameter may be unnamed; a method's `self` is unannotated.
 */
export interface CstFunctionTypeArgument extends CstNodeBase<"FunctionTypeArgument"> {
	name?: Token;
	annotation?: CstType;
	colon?: Token;
}

/**
 * `@name` on its own (`at` present) or `name` inside a bracketed list, with
 * `(args)` or a bare table or string argument when parametrized.
 */
export interface CstAttribute extends CstNodeBase<"Attribute"> {
	name: Token;
	arguments?: Array<Punctuated<CstExpr>>;
	at?: Token;
	close?: Token;
	open?: Token;
}

/** `@[a, b]` */
export interface CstAttributeList extends CstNodeBase<"AttributeList"> {
	close: Token;
	items: Array<Punctuated<CstAttribute>>;
	open: Token;
}

/** Attributes in source order, each bare or grouped into its list. */
export type CstAttributes = Array<CstAttribute | CstAttributeList>;

export interface CstTypeFunction extends CstNodeBase<"TypeFunction"> {
	arrow: Token;
	attributes?: CstAttributes;
	close: Token;
	generics?: CstGenerics;
	open: Token;
	parameters: Array<Punctuated<CstFunctionTypeArgument>>;
	returnType: CstTypePack;
	/** The `...T` or `T...` after the last parameter. */
	tail?: CstTypePack;
}

export interface CstTypeTypeof extends CstNodeBase<"TypeTypeof"> {
	close: Token;
	expr: CstExpr;
	keyword: Token;
	open: Token;
}

/** The `?` of `T?`, a member of the union the parser makes of it. */
export type CstTypeOptional = CstTokenNode<"TypeOptional">;

/**
 * A union or intersection. Unlike every other separated list, each member's
 * separator is the `|` or `&` before it: the first member carries one only
 * when a leading separator is written, and a {@link CstTypeOptional} member
 * has none.
 */
export interface CstTypeUnion extends CstNodeBase<"TypeUnion"> {
	items: Array<Punctuated<CstType>>;
}

export interface CstTypeIntersection extends CstNodeBase<"TypeIntersection"> {
	items: Array<Punctuated<CstType>>;
}

export type CstTypeSingletonBool = CstTokenNode<"TypeSingletonBool">;

export type CstTypeSingletonString = CstTokenNode<"TypeSingletonString">;

export interface CstTypeGroup extends CstNodeBase<"TypeGroup"> {
	close: Token;
	inner: CstType;
	open: Token;
}

export type CstType =
	| CstTypeFunction
	| CstTypeGroup
	| CstTypeIntersection
	| CstTypeOptional
	| CstTypeReference
	| CstTypeSingletonBool
	| CstTypeSingletonString
	| CstTypeTable
	| CstTypeTypeof
	| CstTypeUnion;

/**
 * `(A, B, ...C)`, or a single type standing for a pack (a `-> T` return
 * type), in which case the parens are absent.
 */
export interface CstTypePackExplicit extends CstNodeBase<"TypePackExplicit"> {
	close?: Token;
	items: Array<Punctuated<CstType>>;
	open?: Token;
	tail?: CstTypePack;
}

/** `...T`; the ellipsis is absent on a function's `...: T` annotation. */
export interface CstTypePackVariadic extends CstNodeBase<"TypePackVariadic"> {
	ellipsis?: Token;
	inner: CstType;
}

/** `T...` */
export interface CstTypePackGeneric extends CstNodeBase<"TypePackGeneric"> {
	name: Token;
	ellipsis: Token;
}

export type CstTypePack = CstTypePackExplicit | CstTypePackGeneric | CstTypePackVariadic;

/** `T` or `T = Default` */
export interface CstGenericType extends CstNodeBase<"GenericType"> {
	name: Token;
	default?: CstType;
	equals?: Token;
}

/** `T...` or `T... = Default` */
export interface CstGenericTypePack extends CstNodeBase<"GenericTypePack"> {
	name: Token;
	default?: CstTypePack;
	ellipsis: Token;
	equals?: Token;
}

export interface CstGenerics extends CstNodeBase<"Generics"> {
	close: Token;
	items: Array<Punctuated<CstGenericType | CstGenericTypePack>>;
	open: Token;
}
