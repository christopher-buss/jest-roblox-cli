/**
 * One accumulated span. `elapsedMs` sums every open/close (or `record`) that
 * landed on this node, so repeated calls with the same name accumulate rather
 * than replace.
 */
export interface SpanNode {
	name: string;
	children: Map<string, SpanNode>;
	elapsedMs: number;
}

export interface SpanTree {
	/**
	 * Opens a span under the current frame and pushes it; the returned closer
	 * adds the elapsed time and pops. Opens and closes must be LIFO — see
	 * `createTimingCollector` for the concurrency caveat that follows from it.
	 */
	open: (name: string) => () => void;
	/** Adds `elapsedMs` to a leaf span under the current frame. */
	record: (name: string, elapsedMs: number) => void;
	/** Top-level spans in first-seen order. */
	readonly roots: Map<string, SpanNode>;
}

/**
 * The span bookkeeping behind the timing collector: one shared stack, one root
 * map, and the two ways a span lands in them. Carries no enabled/disabled
 * policy and no rendering — the collector owns both.
 */
export function createSpanTree(clock: { now: () => number }): SpanTree {
	const roots = new Map<string, SpanNode>();
	const stack: Array<SpanNode> = [];

	function open(name: string): () => void {
		const top = stack.at(-1);
		const node = childOf(top === undefined ? roots : top.children, name);
		stack.push(node);
		const start = clock.now();
		return () => {
			node.elapsedMs += clock.now() - start;
			stack.pop();
		};
	}

	function record(name: string, elapsedMs: number): void {
		const top = stack.at(-1);
		const node = childOf(top === undefined ? roots : top.children, name);
		node.elapsedMs += elapsedMs;
	}

	return { open, record, roots };
}

/**
 * Writes every root and its descendants through `sink`, depth-first, and
 * returns the summed root time. Each root contributes its own rounded value, so
 * the total matches the sum of the root lines the caller just emitted.
 */
export function emitSpanTree(roots: Map<string, SpanNode>, sink: (line: string) => void): number {
	let total = 0;
	for (const node of roots.values()) {
		emitNode(node, 0, sink);
		total += Math.round(node.elapsedMs);
	}

	return total;
}

function childOf(parent: Map<string, SpanNode>, name: string): SpanNode {
	let node = parent.get(name);
	if (node === undefined) {
		node = { name, children: new Map(), elapsedMs: 0 };
		parent.set(name, node);
	}

	return node;
}

function emitNode(node: SpanNode, depth: number, sink: (line: string) => void): void {
	const indent = "  ".repeat(depth);
	sink(`[TIMING] ${indent}${node.name}: ${String(Math.round(node.elapsedMs))}ms`);
	for (const child of node.children.values()) {
		emitNode(child, depth + 1, sink);
	}
}
