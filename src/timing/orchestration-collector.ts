import { performance } from "node:perf_hooks";
import process from "node:process";

export interface CreateTimingCollectorOptions {
	clock?: { now: () => number };
	enabled?: boolean;
	sink?: (line: string) => void;
}

export interface TimingCollector {
	/**
	 * Whether this collector actually records/emits anything (`TIMING` env var
	 * set, or an explicit `enabled: true` override). Callers whose work exists
	 * only to feed `record()` — e.g. parsing a raw envelope purely to extract a
	 * value to record — should check this first and skip that work entirely
	 * when disabled, rather than doing it and letting `record()` silently
	 * discard the result.
	 */
	readonly enabled: boolean;
	flushTimingReport: () => void;
	profile: <T>(name: string, func: () => T extends Promise<unknown> ? never : T) => T;
	profileAsync: <T>(name: string, func: () => Promise<T>) => Promise<T>;
	/**
	 * Register a leaf span under the current stack frame whose `elapsedMs` is
	 * supplied directly. Used to surface durations the orchestrator did not
	 * measure itself — the backend reports `uploadMs` / `executionMs` from
	 * inside its own `runTests` call, and the Luau runner reports per-game
	 * phases inside the Roblox VM. Repeated calls with the same `name`
	 * accumulate, matching `profile`'s behavior.
	 *
	 * Stack-empty fallback: when called outside any `profile`/`profileAsync`
	 * frame the span lands at root and contributes to `TOTAL (host)` like
	 * any other root. Call inside the relevant frame to keep totals clean
	 * — recording a value at root that is ALSO captured by a sibling root
	 * `profile` span would double-count toward the host total.
	 */
	record: (name: string, elapsedMs: number) => void;
}

interface SpanNode {
	name: string;
	children: Map<string, SpanNode>;
	elapsedMs: number;
}

/**
 * A buffered span-tree profiler for a single, sequential host run. Nesting is
 * tracked with one shared stack, so spans must open and close in LIFO order:
 * profile a phase, and any spans it opens nest under it. It is NOT safe to run
 * two `profile` / `profileAsync` calls concurrently on the same collector (e.g.
 * `Promise.all`) — interleaved opens/closes would corrupt the stack. Create one
 * collector per run; `flushTimingReport` empties it so a second flush is a
 * no-op.
 */
export function createTimingCollector(options: CreateTimingCollectorOptions = {}): TimingCollector {
	const clock = options.clock ?? { now: () => performance.now() };
	const sink = options.sink ?? ((line: string) => void process.stderr.write(`${line}\n`));
	const enabled = options.enabled ?? process.env["TIMING"] !== undefined;
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

	function profile<T>(name: string, func: () => T extends Promise<unknown> ? never : T): T {
		if (!enabled) {
			return func();
		}

		const close = open(name);
		try {
			return func();
		} finally {
			close();
		}
	}

	async function profileAsync<T>(name: string, func: () => Promise<T>): Promise<T> {
		if (!enabled) {
			return func();
		}

		const close = open(name);
		try {
			return await func();
		} finally {
			close();
		}
	}

	function record(name: string, elapsedMs: number): void {
		if (!enabled) {
			return;
		}

		const top = stack.at(-1);
		const node = childOf(top === undefined ? roots : top.children, name);
		node.elapsedMs += elapsedMs;
	}

	function emit(node: SpanNode, depth: number): void {
		const indent = "  ".repeat(depth);
		sink(`[TIMING] ${indent}${node.name}: ${String(Math.round(node.elapsedMs))}ms`);
		for (const child of node.children.values()) {
			emit(child, depth + 1);
		}
	}

	function flushTimingReport(): void {
		if (!enabled || roots.size === 0) {
			return;
		}

		let total = 0;
		for (const node of roots.values()) {
			emit(node, 0);
			total += Math.round(node.elapsedMs);
		}

		sink(`[TIMING] TOTAL (host): ${String(total)}ms`);
		// Clear so a second flush (the run wraps this in a `finally`) is a no-op
		// rather than re-emitting every recorded span.
		roots.clear();
	}

	return { enabled, flushTimingReport, profile, profileAsync, record };
}

/**
 * Shared disabled collector for callers that thread a profiler through their
 * signatures but are invoked outside a profiled workspace run (single-mode
 * coverage, the `instrument` subcommand, tests). Every method is a no-op.
 */
export const NOOP_TIMING_COLLECTOR: TimingCollector = createTimingCollector({ enabled: false });

function childOf(parent: Map<string, SpanNode>, name: string): SpanNode {
	let node = parent.get(name);
	if (node === undefined) {
		node = { name, children: new Map(), elapsedMs: 0 };
		parent.set(name, node);
	}

	return node;
}
