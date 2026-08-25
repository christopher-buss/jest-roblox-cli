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

export interface CreateSpanTreeOptions {
	/**
	 * Called the moment a span finishes — as `open`'s closer runs, or as
	 * `record` lands a leaf — with the span's ancestor path (root first, the
	 * span itself last) and the duration of that single occurrence. Lets a
	 * caller stream the phase as it completes; the tree keeps accumulating
	 * either way, so a repeated name fires once per occurrence but still
	 * reports one summed node.
	 */
	onSpanComplete: (path: ReadonlyArray<string>, elapsedMs: number) => void;
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
export function createSpanTree(
	clock: { now: () => number },
	{ onSpanComplete }: CreateSpanTreeOptions,
): SpanTree {
	const roots = new Map<string, SpanNode>();
	const stack: Array<SpanNode> = [];

	function open(name: string): () => void {
		const top = stack.at(-1);
		const node = childOf(top === undefined ? roots : top.children, name);
		stack.push(node);
		const start = clock.now();
		return () => {
			const elapsedMs = clock.now() - start;
			node.elapsedMs += elapsedMs;
			// The stack still holds `node` on top, so it already is the path.
			const path = stack.map((frame) => frame.name);
			// Pop before notifying: a sink that throws (stderr EPIPE) must not
			// strand this frame and nest every later span under it.
			stack.pop();
			onSpanComplete(path, elapsedMs);
		};
	}

	function record(name: string, elapsedMs: number): void {
		const top = stack.at(-1);
		const node = childOf(top === undefined ? roots : top.children, name);
		node.elapsedMs += elapsedMs;
		onSpanComplete([...stack.map((frame) => frame.name), name], elapsedMs);
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

/**
 * Renders one completed span as a stream line, identified by its full ancestor
 * path because the stream emits children before their parent — indentation
 * alone would point at a line that has not been written yet.
 */
export function formatStreamedSpan(path: ReadonlyArray<string>, elapsedMs: number): string {
	return formatSpanLine(path.join(" > "), elapsedMs);
}

function childOf(parent: Map<string, SpanNode>, name: string): SpanNode {
	let node = parent.get(name);
	if (node === undefined) {
		node = { name, children: new Map(), elapsedMs: 0 };
		parent.set(name, node);
	}

	return node;
}

/** The single line shape shared by the live stream and the final report. */
function formatSpanLine(label: string, elapsedMs: number): string {
	return `[TIMING] ${label}: ${String(Math.round(elapsedMs))}ms`;
}

function emitNode(node: SpanNode, depth: number, sink: (line: string) => void): void {
	const indent = "  ".repeat(depth);
	sink(formatSpanLine(`${indent}${node.name}`, node.elapsedMs));
	for (const child of node.children.values()) {
		emitNode(child, depth + 1, sink);
	}
}
