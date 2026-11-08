import assert from "node:assert";

import type { Token } from "./cst-token.ts";
import type { CstNode, CstNodeKind, CstWalker, TokenBounds } from "./cst.ts";
import { walkCst } from "./cst.ts";

/**
 * The node of one kind.
 * @template Kind - The `type` the node has.
 */
export type CstNodeOfKind<Kind extends CstNodeKind> = Extract<
	CstNode,
	Readonly<Record<"type", Kind>>
>;

/** The hooks of an index walk. */
export type CstIndexWalker = Pick<CstWalker, "onExit" | "onNode">;

/** A node's positions in `tokens`. */
export interface TokenRange {
	/** Exclusive. */
	readonly end: number;
	/** Equal to `end` for a node that holds no token. */
	readonly start: number;
}

/**
 * One tree as `indexCst` read it. Later edits do not reach it, so its owner
 * builds a new one after each structural edit.
 */
export interface CstIndex {
	/** As `tokenBounds` reads them. */
	boundsOf(node: CstNode): TokenBounds | undefined;
	/** In pre-order, the root first. */
	readonly nodes: ReadonlyArray<CstNode>;
	/** In pre-order. */
	ofKind<Kind extends CstNodeKind>(kind: Kind): ReadonlyArray<CstNodeOfKind<Kind>>;
	/** `undefined` for a node the index does not hold. */
	ordinalOf(node: CstNode): number | undefined;
	/** Built once and shared by every call. */
	parentMap(): ReadonlyMap<CstNode, CstNode>;
	/** `undefined` for the indexed root. */
	parentOf(node: CstNode): CstNode | undefined;
	/** The node's positions in `tokens`. */
	tokenRangeOf(node: CstNode): TokenRange;
	/** In lexical order. */
	readonly tokens: ReadonlyArray<Token>;
	/**
	 * In `walkCst` order. The walk reads the index, so a hook must not edit the
	 * tree.
	 */
	walk(node: CstNode, walker: CstIndexWalker): void;
}

interface IndexArrays {
	readonly firstTokens: Array<number>;
	readonly nodes: Array<CstNode>;
	readonly parents: Array<number>;
	readonly subtreeEnds: Array<number>;
	readonly tokenEnds: Array<number>;
	readonly tokens: Array<Token>;
}

type KindCache = { [Kind in CstNodeKind]?: ReadonlyArray<CstNodeOfKind<Kind>> };

interface IndexState extends IndexArrays {
	readonly kinds: KindCache;
	ordinals: Map<CstNode, number> | undefined;
	parentMap: ReadonlyMap<CstNode, CstNode> | undefined;
}

/**
 * Read a tree once.
 * @param root - The tree or a subtree.
 * @returns Its index.
 */
export function indexCst(root: CstNode): CstIndex {
	const state: IndexState = {
		...readTree(root),
		kinds: {},
		ordinals: undefined,
		parentMap: undefined,
	};
	return {
		boundsOf: (node) => boundsAt(state, ordinalIn(state, node)),
		nodes: state.nodes,
		ofKind: (kind) => nodesOfKind(state, kind),
		ordinalOf: (node) => ordinalsOf(state).get(node),
		parentMap: () => {
			state.parentMap ??= parentMapOf(state);
			return state.parentMap;
		},
		parentOf: (node) => state.nodes[at(state.parents, ordinalIn(state, node))],
		tokenRangeOf: (node) => {
			const ordinal = ordinalIn(state, node);
			return { end: at(state.tokenEnds, ordinal), start: at(state.firstTokens, ordinal) };
		},
		tokens: state.tokens,
		walk: (node, walker) => {
			walkIndexed(state, { start: ordinalIn(state, node), walker });
		},
	};
}

function at<Value>(values: ReadonlyArray<Value>, ordinal: number): Value {
	const value = values[ordinal];
	// Stryker disable next-line ConditionalExpression: every read uses an
	// ordinal the build wrote
	assert(value !== undefined, "an index ordinal is in range");
	return value;
}

function parentMapOf(state: IndexState): ReadonlyMap<CstNode, CstNode> {
	const parents = new Map<CstNode, CstNode>();
	for (const [ordinal, parent] of state.parents.entries()) {
		if (parent >= 0) {
			parents.set(at(state.nodes, ordinal), at(state.nodes, parent));
		}
	}

	return parents;
}

function emptyArrays(): IndexArrays {
	return {
		firstTokens: [],
		nodes: [],
		parents: [],
		subtreeEnds: [],
		tokenEnds: [],
		tokens: [],
	};
}

function readTree(root: CstNode): IndexArrays {
	const arrays = emptyArrays();
	const open: Array<number> = [-1];
	walkCst(root, {
		onExit: () => {
			const ordinal = at(open, open.length - 1);
			open.length -= 1;
			arrays.subtreeEnds[ordinal] = arrays.nodes.length;
			arrays.tokenEnds[ordinal] = arrays.tokens.length;
		},
		onNode: (node) => {
			arrays.parents.push(at(open, open.length - 1));
			arrays.firstTokens.push(arrays.tokens.length);
			open.push(arrays.nodes.length);
			arrays.nodes.push(node);
			return false;
		},
		onToken: (token) => {
			arrays.tokens.push(token);
		},
	});
	return arrays;
}

function ordinalsOf(state: IndexState): ReadonlyMap<CstNode, number> {
	state.ordinals ??= new Map(state.nodes.map((node, ordinal) => [node, ordinal]));
	return state.ordinals;
}

function ordinalIn(state: IndexState, node: CstNode): number {
	const ordinal = ordinalsOf(state).get(node);
	if (ordinal === undefined) {
		const { beginColumn, beginLine } = node.location;
		assert.fail(
			`the index holds no ${node.type} at ${String(beginLine)}:${String(beginColumn)}`,
		);
	}

	return ordinal;
}

function boundsAt(state: IndexArrays, ordinal: number): TokenBounds | undefined {
	const first = at(state.firstTokens, ordinal);
	const end = at(state.tokenEnds, ordinal);
	return first === end
		? undefined
		: { first: at(state.tokens, first), last: at(state.tokens, end - 1) };
}

function isOfKind<Kind extends CstNodeKind>(
	node: CstNode,
	kind: Kind,
): node is CstNodeOfKind<Kind> {
	return node.type === kind;
}

function nodesOfKind<Kind extends CstNodeKind>(
	state: IndexState,
	kind: Kind,
): ReadonlyArray<CstNodeOfKind<Kind>> {
	const cached = state.kinds[kind];
	if (cached !== undefined) {
		return cached;
	}

	const nodes = state.nodes.filter((node) => isOfKind(node, kind));
	Reflect.set(state.kinds, kind, nodes);
	return nodes;
}

function walkIndexed(
	state: IndexArrays,
	{ start, walker: { onExit, onNode } }: { start: number; walker: CstIndexWalker },
): void {
	const end = at(state.subtreeEnds, start);
	const open: Array<number> = [];
	function exitBefore(ordinal: number): void {
		while (open.length > 0 && at(state.subtreeEnds, at(open, open.length - 1)) <= ordinal) {
			onExit?.(at(state.nodes, at(open, open.length - 1)));
			open.length -= 1;
		}
	}

	let ordinal = start;
	while (ordinal < end) {
		exitBefore(ordinal);
		if (onNode?.(at(state.nodes, ordinal)) === true) {
			ordinal = at(state.subtreeEnds, ordinal);
		} else {
			open.push(ordinal);
			ordinal += 1;
		}
	}

	exitBefore(end);
}
