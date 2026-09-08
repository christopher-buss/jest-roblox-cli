/**
 * The concrete syntax tree `parse_to_cst_json` (wasm/wrapper.cpp) emits, once
 * `cst-materialize.ts` has sliced token text and trivia from the source.
 * Every node's slots sit in lexical order, so a walk over a node's values
 * visits its tokens in source order; the printer and the gap detector both
 * rely on that.
 *
 * Type annotations, generics, and attributes are opaque `CstRaw` slices for
 * now.
 */

import type {
	CstElseIfExpr,
	CstExpr,
	CstFunctionBody,
	CstGenerics,
	CstLocalDeclaration,
	CstTableItem,
	CstTypeArguments,
} from "./cst-expressions.ts";
import type { CstBlock, CstElseIf, CstRoot, CstStat } from "./cst-statements.ts";
import { isToken } from "./cst-token.ts";
import type { Token } from "./cst-token.ts";

export type * from "./cst-expressions.ts";
export type * from "./cst-statements.ts";
export type { Token, Trivia } from "./cst-token.ts";
export { isToken } from "./cst-token.ts";

/**
 * Every node kind the serializer emits; `cst-kinds.spec.ts` keeps it in step.
 */
export const CST_NODE_KINDS = [
	"Assign",
	"Binary",
	"Block",
	"Bool",
	"Break",
	"Call",
	"CompoundAssign",
	"Continue",
	"Do",
	"ElseIf",
	"ElseIfExpr",
	"ExprStat",
	"For",
	"ForIn",
	"FunctionBody",
	"FunctionExpr",
	"FunctionStat",
	"Generics",
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
	"Raw",
	"Repeat",
	"Return",
	"Root",
	"String",
	"Table",
	"TableItem",
	"TypeAlias",
	"TypeArguments",
	"TypeAssertion",
	"Unary",
	"Varargs",
	"While",
] as const;

export type CstNodeKind = (typeof CST_NODE_KINDS)[number];

export type CstNode =
	| CstBlock
	| CstElseIf
	| CstElseIfExpr
	| CstExpr
	| CstFunctionBody
	| CstGenerics
	| CstLocalDeclaration
	| CstRoot
	| CstStat
	| CstTableItem
	| CstTypeArguments;

const kindSet: ReadonlySet<string> = new Set(CST_NODE_KINDS);

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
 * Visit every token under a tree, in source order.
 *
 * @param value - The tree, subtree, or slot to walk.
 * @param visit - Called on each token.
 */
export function forEachToken(value: unknown, visit: (token: Token) => void): void {
	walk(value, visit, ignore);
}

/**
 * Visit every node under a tree, each before its children.
 *
 * @param value - The tree, subtree, or slot to walk.
 * @param visit - Called on each node.
 */
export function forEachCstNode(value: unknown, visit: (node: CstNode) => void): void {
	walk(value, ignore, visit);
}

/**
 * Pre-order walk over every value under a tree in lexical order. A node's
 * `location` is its span, not a slot, so it is the one key skipped.
 */
function walk(
	value: unknown,
	onToken: (token: Token) => void,
	onNode: (node: CstNode) => void,
): void {
	if (isToken(value)) {
		onToken(value);
		return;
	}

	if (Array.isArray(value)) {
		for (const element of value) {
			walk(element, onToken, onNode);
		}

		return;
	}

	if (!isRecord(value)) {
		return;
	}

	if (isCstNode(value)) {
		onNode(value);
	}

	for (const key in value) {
		if (key !== "location") {
			walk(value[key], onToken, onNode);
		}
	}
}

function ignore(): void {
	// A walk that only wants the other kind of value.
}
