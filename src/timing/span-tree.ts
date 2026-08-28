/**
 * One accumulated span. `elapsedMs` sums every open/close (or `record`) that
 * landed on this node and `count` counts them, so repeated calls with the same
 * name accumulate into one node rather than replacing it or piling up lines.
 */
export interface SpanNode {
	name: string;
	children: Map<string, SpanNode>;
	/**
	 * Whether an `open` on this node has ever closed. Distinguishes a span the
	 * tree has already reported through a root `onSpanClose` from one that
	 * only ever arrived by `record`, which has no close and so reports nowhere.
	 */
	closed: boolean;
	count: number;
	elapsedMs: number;
}

export interface CreateSpanTreeOptions {
	/**
	 * Called as any span closes, with `isRoot` true for a top-level one. That
	 * root close is the tree's only "nothing more can land here" signal: a
	 * phase that instruments N files closes its Nth `parse-ast` and its own
	 * span in the same breath, so it is the first moment the subtree can be
	 * reported as a total rather than as N separate lines. A root opened twice
	 * fires twice, each time with the running total.
	 *
	 * Depth is carried rather than filtered because the two readers want
	 * different ones: the timing report wants roots, while a user-facing stage
	 * is named wherever the work happens to sit — `processResults` nests under
	 * `runProjects`, and a root-only callback would never see it.
	 */
	onSpanClose: (node: SpanNode, isRoot: boolean) => void;
	/**
	 * Called as any span opens, with `isRoot` true for a top-level one. The
	 * close-time report says where the run has been; this says where it is
	 * now, which is the only thing a run that hangs mid-phase can tell you.
	 */
	onSpanOpen: (node: SpanNode, isRoot: boolean) => void;
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
 * The span bookkeeping behind the timing collector and the line shapes it
 * reports in: one shared stack, one root map, the two ways a span lands in
 * them, and the renderer that turns any of it into text. Carries no
 * enabled/disabled policy and owns no sink — the collector owns both.
 */
export function createSpanTree(
	clock: { now: () => number },
	{ onSpanClose, onSpanOpen }: CreateSpanTreeOptions,
): SpanTree {
	const roots = new Map<string, SpanNode>();
	const stack: Array<SpanNode> = [];

	/** The node this name refers to right now: a child of the open frame. */
	function nodeFor(name: string): SpanNode {
		const top = stack.at(-1);
		return childOf(top === undefined ? roots : top.children, name);
	}

	function open(name: string): () => void {
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
 * Writes `node` and its descendants through `sink`, depth-first, one line per
 * distinct name. A name that ran more than once carries its occurrence count,
 * and any parent whose children do not account for its own elapsed time gets an
 * `(unmeasured)` line for the difference — the gap is usually where a slow
 * phase actually went, since only instrumented work has a name.
 */
export function emitSpanNode(node: SpanNode, sink: (line: string) => void): void {
	emitIndented(node, { depth: 0, sink });
}

/**
 * Everything the closing phases did not already say: each root that never
 * closed — a `record` outside every phase, whose "no more can land" moment
 * never arrives — and then the host total. Each root contributes its own
 * rounded value, so the total matches the sum of the root lines on screen.
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

/** The line that announces a phase, before it has a duration to report. */
export function formatPhaseStart(name: string): string {
	return `[TIMING] ${name}: start`;
}

/**
 * Starts `node`'s clock and hands back the closer that stops it, pops the
 * frame, and — for a top-level phase — reports the finished subtree.
 */
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
}): () => void {
	const start = clock.now();
	return () => {
		node.elapsedMs += clock.now() - start;
		node.count += 1;
		// Both before notifying: a sink that throws (stderr EPIPE) must not
		// strand this frame and nest every later span under it, nor leave the
		// root looking unannounced and get it written a second time.
		node.closed = true;
		stack.pop();
		onSpanClose(node, stack.length === 0);
	};
}

/** Pushes `node` onto the stack and announces it. */
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
		// The caller has no closer yet, so nothing else can pop this frame — a
		// sink that throws (stderr EPIPE) would otherwise nest every later span
		// under a phase that never began.
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

/** The single line shape every `[TIMING]` duration line is built from. */
function formatSpanLine(label: string, elapsedMs: number): string {
	return `[TIMING] ${label}: ${String(Math.round(elapsedMs))}ms`;
}

/**
 * How much of `node` no child claims. Rounded before the caller's threshold
 * test so a sub-millisecond gap never prints as `0ms`. Goes negative when
 * children overlap or measure wall time the parent only partly spans (the
 * in-Roblox `luau.*` records sit inside `backend.runTests`); the caller drops
 * those rather than printing a negative duration.
 */
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
