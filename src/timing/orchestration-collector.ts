import { performance } from "node:perf_hooks";
import process from "node:process";

import { NOOP_RUN_PROGRESS, type RunProgress } from "../progress/reporter.ts";
import { SPAN_STAGES, type StageId } from "../progress/stages.ts";
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
	/**
	 * Where the phases this collector opens are announced to the person
	 * watching. Supplying one keeps the span tree live even with the timing
	 * report off, which is the point: the stages a run reports and the phases
	 * it profiles are then the same events, told twice.
	 */
	progress?: RunProgress;
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
	 * The run's stage reporter, carried here because the collector is already
	 * threaded through every layer that has a stage to announce — the run
	 * header that reveals it, the backend that owns upload and dispatch, the
	 * workspace sink that writes between repaints.
	 */
	readonly progress: RunProgress;
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
	const { progress } = options;
	if (!isEnabled && progress === undefined) {
		return createNoopTimingCollector();
	}

	const reporter = progress ?? NOOP_RUN_PROGRESS;

	const clock = options.clock ?? { now: () => performance.now() };
	const sink = options.sink ?? ((line: string) => void process.stderr.write(`${line}\n`));
	const spans = createObservedSpanTree({ clock, isEnabled, reporter, sink });
	const { profile, profileAsync } = createProfilers(spans);

	function record(name: string, elapsedMs: number): void {
		spans.record(name, elapsedMs);
	}

	return {
		enabled: isEnabled,
		flushTimingReport: createFlusher({ isEnabled, sink, spans }),
		profile,
		profileAsync,
		progress: reporter,
		record,
	};
}

/**
 * Turns span open/close pairs into stage open/close pairs, for the spans
 * `SPAN_STAGES` names. Holds one closer per stage rather than per span, so a
 * phase that runs twice reopens the same stage instead of leaving the first
 * one hanging; a closer left behind after its stage closed is idempotent, so
 * the map keeps at most one entry per stage and never needs clearing.
 */
function createStageAnnouncer(progress: RunProgress): {
	close: (name: string) => void;
	open: (name: string) => void;
} {
	const closers = new Map<StageId, () => void>();
	return {
		close: (name: string) => {
			const stage = SPAN_STAGES[name];
			if (stage === undefined) {
				return;
			}

			closers.get(stage)?.();
		},
		open: (name: string) => {
			const stage = SPAN_STAGES[name];
			if (stage === undefined) {
				return;
			}

			closers.set(stage, progress.begin(stage));
		},
	};
}

/**
 * The one span tree, wired to both of its readers: the `[TIMING]` waterfall,
 * which writes only while the report is on, and the stage reporter, which
 * announces the phases a person is waiting on whether or not it is.
 */
function createObservedSpanTree({
	clock,
	isEnabled,
	reporter,
	sink,
}: {
	clock: { now: () => number };
	isEnabled: boolean;
	reporter: RunProgress;
	sink: (line: string) => void;
}): SpanTree {
	const stages = createStageAnnouncer(reporter);
	return createSpanTree(clock, {
		onSpanClose: (node, isRoot) => {
			stages.close(node.name);
			if (isRoot && isEnabled) {
				emitSpanNode(node, sink);
			}
		},
		onSpanOpen: (node, isRoot) => {
			stages.open(node.name);
			if (isRoot && isEnabled) {
				sink(formatPhaseStart(node.name));
			}
		},
	});
}

/**
 * The end-of-run drain: everything the closing phases did not already say,
 * then the host total. Silent while the report is off, and empties the tree
 * so the second call the run's `finally` makes is a no-op.
 */
function createFlusher({
	isEnabled,
	sink,
	spans,
}: {
	isEnabled: boolean;
	sink: (line: string) => void;
	spans: SpanTree;
}): () => void {
	return () => {
		if (!isEnabled || spans.roots.size === 0) {
			return;
		}

		emitFinalReport(spans.roots, sink);
		spans.roots.clear();
	};
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
		progress: NOOP_RUN_PROGRESS,
		record: noOp,
	};
}

/**
 * The two span-opening entry points for a live collector. Disabled runs
 * receive the direct-call implementations from `createNoopTimingCollector`.
 *
 * Every span opens, including the per-file ones instrumentation opens
 * thousands of and no reader ever asks for. Skipping the unnamed ones was
 * measured at a millisecond or two across a thousand-file coverage run, and
 * bought that with a branch whose two sides are indistinguishable from
 * outside — nothing reads a disabled tree, so nothing can tell.
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
