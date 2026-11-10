/** One accumulated span; repeated names accumulate into one node. */
export interface SpanNode {
	/** The span name, unique among its siblings. */
	name: string;
	/** Child spans by name, in first-seen order. */
	children: Map<string, SpanNode>;
	/** Whether an `open` on this node has ever closed. */
	closed: boolean;
	/** How many opens, closes or records landed on this node. */
	count: number;
	/** Summed duration of every landing, in milliseconds. */
	elapsedMs: number;
}

/** Callbacks a span tree reports opens and closes through. */
export interface CreateSpanTreeOptions {
	/** Called as any span closes, with `isRoot` true for a top-level one. */
	onSpanClose: (node: SpanNode, isRoot: boolean) => void;
	/** Called as any span opens, with `isRoot` true for a top-level one. */
	onSpanOpen: (node: SpanNode, isRoot: boolean) => void;
}

/** A tree of named spans timed against one shared stack. */
export interface SpanTree {
	/**
	 * Opens a span; the closer returns this frame's elapsed time. LIFO only.
	 */
	open: (name: string) => () => number;
	/** Adds `elapsedMs` to a leaf span under the current frame. */
	record: (name: string, elapsedMs: number) => void;
	/** Top-level spans in first-seen order. */
	readonly roots: Map<string, SpanNode>;
}

/**
 * The span bookkeeping behind the timing collector.
 * @param clock - The time source for span durations.
 * @param options - The open and close callbacks.
 * @param options.onSpanClose - Called as any span closes.
 * @param options.onSpanOpen - Called as any span opens.
 * @returns The `open` and `record` entry points over a fresh root map.
 */
export function createSpanTree(
	clock: { now: () => number },
	{ onSpanClose, onSpanOpen }: CreateSpanTreeOptions,
): SpanTree {
	const roots = new Map<string, SpanNode>();
	const stack: Array<SpanNode> = [];

	function nodeFor(name: string): SpanNode {
		const top = stack.at(-1);
		return childOf(top === undefined ? roots : top.children, name);
	}

	function open(name: string): () => number {
		const node = nodeFor(name);
		pushSpan({ node, onSpanOpen, stack });
		return createCloser({ clock, node, onSpanClose, stack });
	}

	function record(name: string, elapsedMs: number): void {
		const node = nodeFor(name);
		node.elapsedMs += elapsedMs;
		node.count += 1;
	}

	return { open, record, roots };
}

/**
 * Writes `node` and its descendants through `sink`, one line per name.
 * @param node - The span to write.
 * @param sink - Receives each line.
 */
export function emitSpanNode(node: SpanNode, sink: (line: string) => void): void {
	emitIndented(node, { depth: 0, sink });
}

/**
 * Writes each never-closed root, then the host total.
 * @param roots - The tree's top-level spans.
 * @param sink - Receives each line.
 */
export function emitFinalReport(roots: Map<string, SpanNode>, sink: (line: string) => void): void {
	let total = 0;
	for (const root of roots.values()) {
		if (!root.closed) {
			emitSpanNode(root, sink);
		}

		total += Math.round(root.elapsedMs);
	}

	sink(formatSpanLine("TOTAL (host)", total));
}

/**
 * The line that announces a phase.
 * @param name - The span that just opened.
 * @returns The `[TIMING]` start line.
 */
export function formatPhaseStart(name: string): string {
	return `[TIMING] ${name}: start`;
}

function createCloser({
	clock,
	node,
	onSpanClose,
	stack,
}: {
	clock: { now: () => number };
	node: SpanNode;
	onSpanClose: (node: SpanNode, isRoot: boolean) => void;
	stack: Array<SpanNode>;
}): () => number {
	const start = clock.now();
	return () => {
		const elapsedMs = clock.now() - start;
		node.elapsedMs += elapsedMs;
		node.count += 1;
		// Before notifying: a throwing sink (EPIPE) must not strand this frame.
		node.closed = true;
		stack.pop();
		onSpanClose(node, stack.length === 0);
		return elapsedMs;
	};
}

function pushSpan({
	node,
	onSpanOpen,
	stack,
}: {
	node: SpanNode;
	onSpanOpen: (node: SpanNode, isRoot: boolean) => void;
	stack: Array<SpanNode>;
}): void {
	stack.push(node);
	try {
		onSpanOpen(node, stack.length === 1);
	} catch (err) {
		// The caller has no closer yet, so nothing else can pop this frame.
		stack.pop();
		throw err;
	}
}

function childOf(parent: Map<string, SpanNode>, name: string): SpanNode {
	let node = parent.get(name);
	if (node === undefined) {
		node = { name, children: new Map(), closed: false, count: 0, elapsedMs: 0 };
		parent.set(name, node);
	}

	return node;
}

function formatSpanLine(label: string, elapsedMs: number): string {
	return `[TIMING] ${label}: ${String(Math.round(elapsedMs))}ms`;
}

function unmeasuredTimeOf(node: SpanNode): number {
	if (node.children.size === 0) {
		return 0;
	}

	let childrenMs = 0;
	for (const child of node.children.values()) {
		childrenMs += child.elapsedMs;
	}

	return Math.round(node.elapsedMs - childrenMs);
}

function emitIndented(
	node: SpanNode,
	{ depth, sink }: { depth: number; sink: (line: string) => void },
): void {
	const indent = "  ".repeat(depth);
	const occurrences = node.count > 1 ? ` (×${String(node.count)})` : "";
	const line = formatSpanLine(`${indent}${node.name}`, node.elapsedMs);
	sink(`${line}${occurrences}`);
	for (const child of node.children.values()) {
		emitIndented(child, { depth: depth + 1, sink });
	}

	const unmeasuredMs = unmeasuredTimeOf(node);
	if (unmeasuredMs >= 1) {
		sink(formatSpanLine(`${indent}  (unmeasured)`, unmeasuredMs));
	}
}
