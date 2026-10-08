/**
 * Type-level nodes of the concrete syntax tree: type annotations, type
 * packs, generics, and attributes. Slots are listed in alphabetical order;
 * `CST_SLOTS` holds the lexical order.
 */

import type {
	CstExpr,
	CstGlobal,
	CstLocalRef,
	CstNodeBase,
	CstTokenNode,
	Punctuated,
} from "./cst-expression-types.ts";
import type { Token } from "./cst-token.ts";

/**
 * A named or qualified type, with its arguments when it has any. The
 * prefix of a qualified name is a name expression, so a prefix that
 * resolves to a local carries the local's binding.
 */
export interface CstTypeReference extends CstNodeBase<"TypeReference"> {
	/** Referenced type name token after any qualifier. */
	name: Token;
	/** Type arguments paired with their trailing separators. */
	arguments?: Array<Punctuated<CstType | CstTypePack>>;
	/** Closing delimiter token. */
	close?: Token;
	/** Dot token separating the qualifier from the type name. */
	dot?: Token;
	/** Opening delimiter token. */
	open?: Token;
	/** Qualifier expression before the type name. */
	prefix?: CstGlobal | CstLocalRef;
}

/**
 * One member of a table type or an extern type body: a property (`name`,
 * with `open` and `close` when it is written `["name"]`), an indexer
 * (`key`), or the element type of an array-like `{ T }` (`value` alone).
 */
export interface CstTypeTableItem extends CstNodeBase<"TypeTableItem"> {
	/** Indexer key type, absent for named properties and array types. */
	key?: CstType;
	/** Property name token, absent for indexers and array types. */
	name?: Token;
	/** `read` or `write`. */
	access?: Token;
	/** Closing delimiter token. */
	close?: Token;
	/** Colon introducing the type annotation. */
	colon?: Token;
	/** Opening delimiter token. */
	open?: Token;
	/** Separator token, absent when the entry has none. */
	separator?: Token;
	/** Value type of the property, indexer, or array element. */
	value: CstType;
}

/** A table type retaining its braces and members. */
export interface CstTypeTable extends CstNodeBase<"TypeTable"> {
	/** Closing delimiter token. */
	close: Token;
	/** Entries in source order. */
	items: Array<CstTypeTableItem>;
	/** Opening delimiter token. */
	open: Token;
}

/**
 * A parameter of a function type or a `declare` signature. A function
 * type's parameter may be unnamed; a method's `self` is unannotated.
 */
export interface CstFunctionTypeArgument extends CstNodeBase<"FunctionTypeArgument"> {
	/** Parameter name token, absent for an unnamed parameter. */
	name?: Token;
	/** Type annotation attached to the expression or declaration. */
	annotation?: CstType;
	/** Colon introducing the type annotation. */
	colon?: Token;
}

/**
 * `@name` on its own (`at` present) or `name` inside a bracketed list, with
 * `(args)` or a bare table or string argument when parametrized.
 */
export interface CstAttribute extends CstNodeBase<"Attribute"> {
	/** Attribute name token following the at-sign or inside a list. */
	name: Token;
	/** Attribute arguments paired with their trailing separators. */
	arguments?: Array<Punctuated<CstExpr>>;
	/** At-sign token introducing a bare attribute. */
	at?: Token;
	/** Closing delimiter token. */
	close?: Token;
	/** Opening delimiter token. */
	open?: Token;
}

/** A bracketed attribute list: `@[a, b]`. */
export interface CstAttributeList extends CstNodeBase<"AttributeList"> {
	/** Closing delimiter token. */
	close: Token;
	/** Entries in source order. */
	items: Array<Punctuated<CstAttribute>>;
	/** Opening delimiter token. */
	open: Token;
}

/** Attributes in source order, each bare or grouped into its list. */
export type CstAttributes = Array<CstAttribute | CstAttributeList>;

/** A function type retaining parameters, generics, and return pack. */
export interface CstTypeFunction extends CstNodeBase<"TypeFunction"> {
	/** Arrow token preceding the function return type. */
	arrow: Token;
	/** Attributes attached to the declaration. */
	attributes?: CstAttributes;
	/** Closing delimiter token. */
	close: Token;
	/** Generic type parameters attached to the declaration. */
	generics?: CstGenerics;
	/** Opening delimiter token. */
	open: Token;
	/** Parameters in source order, each with its separator. */
	parameters: Array<Punctuated<CstFunctionTypeArgument>>;
	/** Function return type pack. */
	returnType: CstTypePack;
	/** The `...T` or `T...` after the last parameter. */
	tail?: CstTypePack;
}

/** A typeof type annotation retaining its expression. */
export interface CstTypeTypeof extends CstNodeBase<"TypeTypeof"> {
	/** Closing delimiter token. */
	close: Token;
	/** Expression whose inferred type the annotation selects. */
	expr: CstExpr;
	/** Typeof keyword introducing the annotation. */
	keyword: Token;
	/** Opening delimiter token. */
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
	/** Union members paired with their preceding pipe token. */
	items: Array<Punctuated<CstType>>;
}

/** An intersection of types with leading separator tokens. */
export interface CstTypeIntersection extends CstNodeBase<"TypeIntersection"> {
	/** Intersection members paired with their preceding ampersand token. */
	items: Array<Punctuated<CstType>>;
}

/** A boolean singleton type and its literal token. */
export type CstTypeSingletonBool = CstTokenNode<"TypeSingletonBool">;

/** A string singleton type and its literal token. */
export type CstTypeSingletonString = CstTokenNode<"TypeSingletonString">;

/** A parenthesized type annotation. */
export interface CstTypeGroup extends CstNodeBase<"TypeGroup"> {
	/** Closing delimiter token. */
	close: Token;
	/** Type wrapped by this group or type pack. */
	inner: CstType;
	/** Opening delimiter token. */
	open: Token;
}

/** Every type annotation kind in the concrete syntax tree. */
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
	/** Closing delimiter token. */
	close?: Token;
	/** Fixed type-pack elements with their trailing separators. */
	items: Array<Punctuated<CstType>>;
	/** Opening delimiter token. */
	open?: Token;
	/** Trailing variadic or generic type pack. */
	tail?: CstTypePack;
}

/** `...T`; the ellipsis is absent on a function's `...: T` annotation. */
export interface CstTypePackVariadic extends CstNodeBase<"TypePackVariadic"> {
	/** Ellipsis token marking a variadic or generic type pack. */
	ellipsis?: Token;
	/** Type wrapped by this group or type pack. */
	inner: CstType;
}

/** A named generic type pack: `T...`. */
export interface CstTypePackGeneric extends CstNodeBase<"TypePackGeneric"> {
	/** Name token of the referenced generic type pack. */
	name: Token;
	/** Ellipsis token marking a variadic or generic type pack. */
	ellipsis: Token;
}

/** An explicit, named generic, or variadic type pack. */
export type CstTypePack = CstTypePackExplicit | CstTypePackGeneric | CstTypePackVariadic;

/** A generic type parameter: `T` or `T = Default`. */
export interface CstGenericType extends CstNodeBase<"GenericType"> {
	/** Generic type parameter name token. */
	name: Token;
	/** Default type or type pack when supplied. */
	default?: CstType;
	/** Equals token introducing the default type. */
	equals?: Token;
}

/** A generic pack parameter: `T...` or `T... = Default`. */
export interface CstGenericTypePack extends CstNodeBase<"GenericTypePack"> {
	/** Generic type-pack parameter name token. */
	name: Token;
	/** Default type or type pack when supplied. */
	default?: CstTypePack;
	/** Ellipsis token marking a variadic or generic type pack. */
	ellipsis: Token;
	/** Equals token introducing the default type pack. */
	equals?: Token;
}

/** A generic parameter list retaining its angle brackets. */
export interface CstGenerics extends CstNodeBase<"Generics"> {
	/** Closing delimiter token. */
	close: Token;
	/** Entries in source order. */
	items: Array<Punctuated<CstGenericType | CstGenericTypePack>>;
	/** Opening delimiter token. */
	open: Token;
}
