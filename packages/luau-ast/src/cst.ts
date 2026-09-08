/**
 * The concrete syntax tree `parse_to_cst_json` (wasm/wrapper.cpp) emits, once
 * `cst-materialize.ts` has sliced token text and trivia from the source.
 * Every node's slots sit in lexical order, so a walk over a node's values
 * visits its tokens in source order; the printer and the gap detector both
 * rely on that. Every node kind at the pinned Luau version is modelled; a
 * slot is never named `type`, which is the kind.
 */

import type {
	CstElseIfExpr,
	CstExpr,
	CstFunctionBody,
	CstLocalDeclaration,
	CstTableItem,
	CstTypeArguments,
} from "./cst-expressions.ts";
import type {
	CstBlock,
	CstElseIf,
	CstExternTypeMethod,
	CstRoot,
	CstStat,
} from "./cst-statements.ts";
import { isToken } from "./cst-token.ts";
import type { Token } from "./cst-token.ts";
import type {
	CstAttribute,
	CstAttributeList,
	CstFunctionTypeArgument,
	CstGenerics,
	CstGenericType,
	CstGenericTypePack,
	CstType,
	CstTypePack,
	CstTypeTableItem,
} from "./cst-types.ts";

export type * from "./cst-expressions.ts";
export type * from "./cst-statements.ts";
export type { Token, Trivia } from "./cst-token.ts";
export { isToken } from "./cst-token.ts";
export type * from "./cst-types.ts";

/**
 * Every node kind the serializer emits; `cst-kinds.spec.ts` keeps it in step.
 */
export const CST_NODE_KINDS = [
	"Assign",
	"Attribute",
	"AttributeList",
	"Binary",
	"Block",
	"Bool",
	"Break",
	"Call",
	"CompoundAssign",
	"Continue",
	"DeclareExternType",
	"DeclareFunction",
	"DeclareGlobal",
	"Do",
	"ElseIf",
	"ElseIfExpr",
	"ExprStat",
	"ExternTypeMethod",
	"For",
	"ForIn",
	"FunctionBody",
	"FunctionExpr",
	"FunctionStat",
	"FunctionTypeArgument",
	"Generics",
	"GenericType",
	"GenericTypePack",
	"Global",
	"Group",
	"If",
	"IfElse",
	"IndexExpr",
	"IndexName",
	"Instantiate",
	"InterpString",
	"Local",
	"LocalDecl",
	"LocalFunction",
	"LocalRef",
	"Nil",
	"Number",
	"Repeat",
	"Return",
	"Root",
	"String",
	"Table",
	"TableItem",
	"TypeAlias",
	"TypeArguments",
	"TypeAssertion",
	"TypeFunction",
	"TypeFunctionStat",
	"TypeGroup",
	"TypeIntersection",
	"TypeOptional",
	"TypePackExplicit",
	"TypePackGeneric",
	"TypePackVariadic",
	"TypeReference",
	"TypeSingletonBool",
	"TypeSingletonString",
	"TypeTable",
	"TypeTableItem",
	"TypeTypeof",
	"TypeUnion",
	"Unary",
	"Varargs",
	"While",
] as const;

export type CstNodeKind = (typeof CST_NODE_KINDS)[number];

export type CstNode =
	| CstAttribute
	| CstAttributeList
	| CstBlock
	| CstElseIf
	| CstElseIfExpr
	| CstExpr
	| CstExternTypeMethod
	| CstFunctionBody
	| CstFunctionTypeArgument
	| CstGenerics
	| CstGenericType
	| CstGenericTypePack
	| CstLocalDeclaration
	| CstRoot
	| CstStat
	| CstTableItem
	| CstType
	| CstTypeArguments
	| CstTypePack
	| CstTypeTableItem;

const kindSet: ReadonlySet<string> = new Set(CST_NODE_KINDS);

/** The first and last token under a node. */
export interface TokenBounds {
	first: Token;
	last: Token;
}

export interface CstWalker {
	/**
	 * Called on each node before its children; return `true` to claim the
	 * node and skip them.
	 */
	onNode?: (node: CstNode) => boolean | undefined;
	onToken?: (token: Token) => void;
}

/**
 * Whether a value is a plain object whose slots can be walked: a node, a
 * punctuated entry, or a span.
 *
 * @param value - Any value reached by walking the tree.
 * @returns Whether it is a plain object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a value in the tree is a node rather than a token, a list, or a
 * punctuated entry.
 *
 * @param value - Any value reached by walking the tree.
 * @returns Whether it is a node.
 */
export function isCstNode(value: unknown): value is CstNode {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		typeof value.type === "string" &&
		kindSet.has(value.type)
	);
}

/**
 * Pre-order walk over every value under a tree in lexical order. A node's
 * `location` is its span, not a slot, so it is the one key skipped.
 *
 * @param value - The tree, subtree, or slot to walk.
 * @param walker - The hooks to call.
 */
export function walkCst(value: unknown, walker: CstWalker): void {
	if (isToken(value)) {
		walker.onToken?.(value);
		return;
	}

	if (Array.isArray(value)) {
		for (const element of value) {
			walkCst(element, walker);
		}

		return;
	}

	if (!isRecord(value)) {
		return;
	}

	if (isCstNode(value) && walker.onNode?.(value) === true) {
		return;
	}

	for (const key in value) {
		if (key !== "location") {
			walkCst(value[key], walker);
		}
	}
}

/**
 * Visit every token under a tree, in source order.
 *
 * @param value - The tree, subtree, or slot to walk.
 * @param visit - Called on each token.
 */
export function forEachToken(value: unknown, visit: (token: Token) => void): void {
	walkCst(value, { onToken: visit });
}

/**
 * The first and last token under a node, or `undefined` for a node with no
 * tokens, such as an empty block.
 *
 * @param node - The node.
 * @returns Its outermost tokens.
 */
export function tokenBounds(node: CstNode): TokenBounds | undefined {
	let bounds: TokenBounds | undefined;
	forEachToken(node, (token) => {
		if (bounds === undefined) {
			bounds = { first: token, last: token };
		} else {
			bounds.last = token;
		}
	});

	return bounds;
}

/**
 * Visit every node under a tree, each before its children.
 *
 * @param value - The tree, subtree, or slot to walk.
 * @param visit - Called on each node.
 */
export function forEachCstNode(value: unknown, visit: (node: CstNode) => void): void {
	walkCst(value, {
		onNode: (node) => {
			visit(node);
		},
	});
}
