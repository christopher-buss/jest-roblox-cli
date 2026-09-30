/**
 * The concrete syntax tree `parse_to_cst_json` (wasm/wrapper.cpp) emits, once
 * `cst-materialize.ts` has sliced token text and trivia from the source.
 * The serializer writes every node's slots in lexical order, which the gap
 * detector relies on; walks take that order from `CST_SLOTS`, not key order.
 * Every node kind at the pinned Luau version is modelled; a slot is never
 * named `type`, which is the kind.
 */

import assert from "node:assert";

import type {
	CstElseIfExpr,
	CstExpr,
	CstFunctionBody,
	CstLocalDeclaration,
	CstTableItem,
	CstTypeArguments,
	Punctuated,
} from "./cst-expressions.ts";
import { CST_SLOTS, punctuatedSlots } from "./cst-slots.ts";
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

/**
 * What a walk enters: a tree or subtree, a token, a list slot and its
 * punctuated entries, or `undefined` for an absent optional slot.
 */
export type CstValue = CstNode | Punctuated<CstNode> | ReadonlyArray<CstValue> | Token | undefined;

const kindSet: ReadonlySet<string> = new Set(CST_NODE_KINDS);

/** The first and last token under a node. */
export interface TokenBounds {
	first: Token;
	last: Token;
}

export interface CstWalker {
	/** Called after the children of each node `onNode` did not claim. */
	onExit?: (node: CstNode) => void;
	/**
	 * Called on each node before its children; return `true` to claim the
	 * node and skip them.
	 */
	onNode?: (node: CstNode) => boolean | undefined;
	onToken?: (token: Token) => void;
	/** Whether to leave one of a node's slots closed. */
	skipSlot?: (node: CstNode, slot: string) => boolean;
}

interface WalkHooks extends CstWalker {
	/** Checked before every value; `true` ends the walk. */
	isDone?: () => boolean;
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
 * Pre-order walk over every value under a tree in lexical order, visiting
 * each node's slots in `CST_SLOTS` order whatever order its keys are in.
 *
 * @param value - The tree, subtree, or slot to walk.
 * @param walker - The hooks to call.
 */
export function walkCst(value: CstValue, walker: CstWalker): void {
	walk(value, walker);
}

/**
 * Whether any node under a tree satisfies a predicate. The walk stops at the
 * first match.
 *
 * @param value - The tree, subtree, or slot to walk.
 * @param predicate - Tested against every node, the root included.
 * @returns Whether any node matched.
 */
export function someCstNode(value: CstValue, predicate: (node: CstNode) => boolean): boolean {
	let isFound = false;
	walk(value, {
		isDone: () => isFound,
		onNode: (node) => {
			isFound = predicate(node);
			return isFound;
		},
	});

	return isFound;
}

/**
 * Visit every token under a tree, in source order.
 *
 * @param value - The tree, subtree, or slot to walk.
 * @param visit - Called on each token.
 */
export function forEachToken(value: CstValue, visit: (token: Token) => void): void {
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
export function forEachCstNode(value: CstValue, visit: (node: CstNode) => void): void {
	walkCst(value, {
		onNode: (node) => {
			visit(node);
		},
	});
}

function isCstList(value: CstValue): value is ReadonlyArray<CstValue> {
	return Array.isArray(value);
}

/** `parent`, the nearest enclosing node's kind, orders a punctuated entry. */
function walk(value: CstValue, hooks: WalkHooks, parent?: CstNodeKind): void {
	if (value === undefined || hooks.isDone?.() === true) {
		return;
	}

	if (isCstList(value)) {
		for (const element of value) {
			walk(element, hooks, parent);
		}

		return;
	}

	// Only a node has `type` and only a token has `text`; the walk is hot.
	if ("type" in value) {
		walkNode(value, hooks);
		return;
	}

	if ("text" in value) {
		hooks.onToken?.(value);
		return;
	}

	for (const slot of punctuatedSlots(parent)) {
		walk(value[slot], hooks, parent);
	}
}

/** A slot never holds a bare punctuated entry, only a list of them. */
function isCstValue(value: unknown): value is CstValue {
	return value === undefined || isToken(value) || isCstNode(value) || Array.isArray(value);
}

/** `CST_SLOTS` lists only slots, and every slot holds a walkable value. */
function readSlot(node: CstNode, slot: string): CstValue {
	const value: unknown = Reflect.get(node, slot);
	if (!isCstValue(value)) {
		assert.fail(`${node.type}.${slot} holds no node, token, or list`);
	}

	return value;
}

function walkNode(node: CstNode, hooks: WalkHooks): void {
	if (hooks.onNode?.(node) === true) {
		return;
	}

	const slots: ReadonlyArray<string> = CST_SLOTS[node.type];
	for (const slot of slots) {
		if (hooks.skipSlot?.(node, slot) !== true) {
			walk(readSlot(node, slot), hooks, node.type);
		}
	}

	hooks.onExit?.(node);
}
