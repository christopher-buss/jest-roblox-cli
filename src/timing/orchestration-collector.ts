import { performance } from "node:perf_hooks";
import process from "node:process";

import {
	createSpanTree,
	emitFinalReport,
	emitSpanNode,
	formatPhaseStart,
	type SpanTree,
} from "./span-tree.ts";

/**
 * A phase's value and its duration in whole milliseconds.
 * @template T
 */
export interface TimedPhase<T> {
	/** Rounded duration of the phase. */
	elapsedMs: number;
	/** What the phase returned. */
	value: T;
}

/** Receives the name of each span as it opens and closes. */
export interface SpanListener {
	/** Called as the span named `name` closes. */
	close: (name: string) => void;
	/** Called as the span named `name` opens. */
	open: (name: string) => void;
}

/** Overrides for {@link createTimingCollector}. */
export interface CreateTimingCollectorOptions {
	/** Time source; defaults to `performance.now`. */
	clock?: {
		/** Current time in milliseconds. */
		now: () => number;
	};
	/** Turn the report on; the run's `TIMING` setting. Defaults to off. */
	enabled?: boolean;
	/** Told of every span as it opens and closes, even with the report off. */
	listener?: SpanListener;
	/** Receives each report line; defaults to stderr. */
	sink?: (line: string) => void;
}

/** The run's span profiler. */
export interface TimingCollector {
	/** Whether the timing report is on. */
	readonly enabled: boolean;
	/** Write every unreported span and the host total, then empty the tree. */
	flushTimingReport: () => void;
	/** Run a synchronous phase inside a span named `name`. */
	profile: <T>(name: string, func: () => T extends Promise<unknown> ? never : T) => T;
	/** Run an async phase inside a span named `name`. */
	profileAsync: <T>(name: string, func: () => Promise<T>) => Promise<T>;
	/** `profile`, plus the phase's duration; measures even when disabled. */
	profileTimed: <T>(
		name: string,
		func: () => T extends Promise<unknown> ? never : T,
	) => TimedPhase<T>;
	/** {@link TimingCollector.profileAsync}, timed as `profileTimed` is. */
	profileTimedAsync: <T>(name: string, func: () => Promise<T>) => Promise<TimedPhase<T>>;
	/** Add a leaf span with a given duration under the current frame. */
	record: (name: string, elapsedMs: number) => void;
}

/**
 * A span-tree profiler for one sequential host run. Spans share one stack:
 * never run two `profile*` calls concurrently on one collector.
 * @param options - Overrides for the clock, enablement, listener and sink.
 * @returns The collector; a no-op one when disabled with no listener.
 */
export function createTimingCollector(options: CreateTimingCollectorOptions = {}): TimingCollector {
	const isEnabled = options.enabled ?? false;
	const { listener } = options;
	const clock = options.clock ?? { now: () => performance.now() };
	if (!isEnabled && listener === undefined) {
		return createNoopTimingCollector(clock);
	}

	const sink = options.sink ?? ((line: string) => void process.stderr.write(`${line}\n`));
	const spans = createObservedSpanTree({ clock, isEnabled, listener, sink });
	const profilers = createProfilers(spans);

	function record(name: string, elapsedMs: number): void {
		spans.record(name, elapsedMs);
	}

	return {
		enabled: isEnabled,
		flushTimingReport: createFlusher({ isEnabled, sink, spans }),
		...profilers,
		record,
	};
}

function createObservedSpanTree({
	clock,
	isEnabled,
	listener,
	sink,
}: {
	clock: { now: () => number };
	isEnabled: boolean;
	listener: SpanListener | undefined;
	sink: (line: string) => void;
}): SpanTree {
	return createSpanTree(clock, {
		onSpanClose: (node, isRoot) => {
			listener?.close(node.name);
			if (isRoot && isEnabled) {
				emitSpanNode(node, sink);
			}
		},
		onSpanOpen: (node, isRoot) => {
			listener?.open(node.name);
			if (isRoot && isEnabled) {
				sink(formatPhaseStart(node.name));
			}
		},
	});
}

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

/**
 * The caller closes the frame on success; a `finally` would close it twice.
 *
 * @template T - Result type of the phase.
 * @param close - Closes the frame.
 * @param func - The phase to run.
 * @returns What `func` returns.
 * @throws {unknown} Whatever `func` throws, after closing the frame.
 */
function closeOnThrow<T>(
	close: () => number,
	func: () => T extends Promise<unknown> ? never : T,
): T {
	try {
		return func();
	} catch (err) {
		close();
		throw err;
	}
}

async function closeOnThrowAsync<T>(close: () => number, func: () => Promise<T>): Promise<T> {
	try {
		return await func();
	} catch (err) {
		close();
		throw err;
	}
}

function createTimedProfilers(
	open: (name: string) => () => number,
): Pick<TimingCollector, "profileTimed" | "profileTimedAsync"> {
	function profileTimed<T>(
		name: string,
		func: () => T extends Promise<unknown> ? never : T,
	): TimedPhase<T> {
		const close = open(name);
		const value = closeOnThrow<T>(close, func);
		return { elapsedMs: Math.round(close()), value };
	}

	async function profileTimedAsync<T>(
		name: string,
		func: () => Promise<T>,
	): Promise<TimedPhase<T>> {
		const close = open(name);
		const value = await closeOnThrowAsync(close, func);
		return { elapsedMs: Math.round(close()), value };
	}

	return { profileTimed, profileTimedAsync };
}

function createNoopTimingCollector(clock: { now: () => number }): TimingCollector {
	return {
		enabled: false,
		flushTimingReport: noOp,
		profile: passthroughProfile,
		profileAsync: passthroughProfileAsync,
		...createTimedProfilers((_name: string) => {
			const start = clock.now();
			return () => clock.now() - start;
		}),
		record: noOp,
	};
}

function createProfilers(
	spans: SpanTree,
): Pick<TimingCollector, "profile" | "profileAsync" | "profileTimed" | "profileTimedAsync"> {
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

	return { profile, profileAsync, ...createTimedProfilers(spans.open) };
}

/** Shared disabled collector for callers outside a profiled run. */
export const NOOP_TIMING_COLLECTOR: TimingCollector = createTimingCollector({ enabled: false });
