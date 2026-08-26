import { performance } from "node:perf_hooks";
import process from "node:process";

import {
	createSpanTree,
	emitFinalReport,
	emitSpanNode,
	formatPhaseStart,
	type SpanTree,
} from "./span-tree.ts";

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

/**
 * A span-tree profiler for a single, sequential host run. Each top-level phase
 * announces itself as it opens and reports its whole subtree the moment it
 * closes, so a long run says where it is and where it has been without
 * narrating every span inside it; anything still unreported by the end
 * (root-level `record` calls, whose "no more can land" moment never arrives)
 * comes out at `flushTimingReport`, followed by the host total.
 * Nesting is tracked with one shared stack, so spans must open and close in
 * LIFO order: profile a phase, and any spans it opens nest under it. It is NOT
 * safe to run two `profile` / `profileAsync` calls concurrently on the same
 * collector (e.g. `Promise.all`) — interleaved opens/closes would corrupt the
 * stack. Create one collector per run; `flushTimingReport` empties it so a
 * second flush is a no-op.
 */
export function createTimingCollector(options: CreateTimingCollectorOptions = {}): TimingCollector {
	const isEnabled = options.enabled ?? process.env["TIMING"] !== undefined;
	if (!isEnabled) {
		return createNoopTimingCollector();
	}

	const clock = options.clock ?? { now: () => performance.now() };
	const sink = options.sink ?? ((line: string) => void process.stderr.write(`${line}\n`));
	// No enabled check here — a disabled collector never opens or records a
	// span, so nothing ever reaches these callbacks.
	const spans = createSpanTree(clock, {
		onRootComplete: (root) => {
			emitSpanNode(root, sink);
		},
		onRootOpen: (root) => {
			sink(formatPhaseStart(root.name));
		},
	});
	const { profile, profileAsync } = createProfilers(spans);

	function record(name: string, elapsedMs: number): void {
		spans.record(name, elapsedMs);
	}

	function flushTimingReport(): void {
		if (spans.roots.size === 0) {
			return;
		}

		emitFinalReport(spans.roots, sink);
		// Clear so a second flush (the run wraps this in a `finally`) is a no-op
		// rather than re-emitting every recorded span.
		spans.roots.clear();
	}

	return { enabled: true, flushTimingReport, profile, profileAsync, record };
}

function noOp(): void {
	// Deliberately empty.
}

function passthroughProfile<T>(
	_name: string,
	func: () => T extends Promise<unknown> ? never : T,
): T {
	return func();
}

async function passthroughProfileAsync<T>(_name: string, func: () => Promise<T>): Promise<T> {
	return func();
}

function createNoopTimingCollector(): TimingCollector {
	return {
		enabled: false,
		flushTimingReport: noOp,
		profile: passthroughProfile,
		profileAsync: passthroughProfileAsync,
		record: noOp,
	};
}

/**
 * The two span-opening entry points for an enabled collector. Disabled runs
 * receive the direct-call implementations from `createNoopTimingCollector`.
 */
function createProfilers(spans: SpanTree): Pick<TimingCollector, "profile" | "profileAsync"> {
	function profile<T>(name: string, func: () => T extends Promise<unknown> ? never : T): T {
		const close = spans.open(name);
		try {
			return func();
		} finally {
			close();
		}
	}

	async function profileAsync<T>(name: string, func: () => Promise<T>): Promise<T> {
		const close = spans.open(name);
		try {
			return await func();
		} finally {
			close();
		}
	}

	return { profile, profileAsync };
}

/**
 * Shared disabled collector for callers that thread a profiler through their
 * signatures but are invoked outside a profiled workspace run (single-mode
 * coverage, the `instrument` subcommand, tests). Every method is a no-op.
 */
export const NOOP_TIMING_COLLECTOR: TimingCollector = createTimingCollector({ enabled: false });
