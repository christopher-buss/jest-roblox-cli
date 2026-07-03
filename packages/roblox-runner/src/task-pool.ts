import { ApiError, RateLimitError } from "@bedrock-rbx/ocale";

import { setTimeout as delay } from "node:timers/promises";

import type { ScriptResult } from "./types.ts";

/**
 * Measured Open Cloud per-place active-task ceiling — a platform constant, not a
 * tuning knob. `P` places offer `10·P` concurrent task slots, so the pool caps
 * each place's slot share here and warns when the requested total exceeds the
 * aggregate ceiling.
 */
const MAX_TASKS_PER_PLACE = 10;

/**
 * A freed slot needs ~10s before its place will accept a new task. A backoff
 * signal inside this window after a completion on that place is slot-recycle
 * lag, not a genuinely-full place, so the pool waits out the remainder of the
 * window rather than treating it as a hard place-full signal (and burning the
 * shared creation budget on an immediate retry storm).
 */
const RECYCLE_LAG_MS = 10_000;

/** Backoff when a place pushes back with no server-supplied retry delay. */
const DEFAULT_BACKOFF_MS = 5_000;

export interface TaskPoolPlace {
	/** Launch one task on this place; resolves with the task's return envelope. */
	runTask: () => Promise<ScriptResult>;
}

export interface TaskPoolOptions {
	/**
	 * Total task-slots across every place. Distributed as evenly as possible and
	 * capped at {@link MAX_TASKS_PER_PLACE} per place; a total above
	 * `places × 10` is clamped to that capacity and reported through
	 * {@link TaskPoolOptions.warn}.
	 */
	concurrency: number;
	/**
	 * True once every enqueued unit has a terminal result. The pool stops
	 * launching new tasks once this returns true and resolves after the in-flight
	 * tasks settle. Owned by the consumer (e.g. the mutation runner tracks which
	 * global indices have a verdict).
	 */
	isDone: () => boolean;
	/** Wall clock in milliseconds; injected for tests. Defaults to `Date.now`. */
	now?: () => number;
	/** Observe a task that threw an error the pool does not back off on. */
	onError?: (error: unknown) => void;
	/** Fold a settled task's envelope into the consumer's result set. */
	onResult: (result: ScriptResult) => void;
	/**
	 * Places the one universe-scoped queue is drained across (no federation).
	 * `concurrency` spreads across this list capped at 10/place; a single entry
	 * is the unchanged single-place behaviour. At least one is required.
	 */
	places: ReadonlyArray<TaskPoolPlace>;
	/** Backoff sleep; injected for tests. Defaults to a real timer. */
	sleep?: (ms: number) => Promise<void>;
	/** One-line warning sink for an over-capacity total. Defaults to `console.warn`. */
	warn?: (message: string) => void;
}

/** A platform backoff signal the pool waits out and retries (never an error). */
interface BackoffSignal {
	/** Server-supplied retry delay, when the signal carried one (a 429). */
	retryAfterMs?: number;
}

/** A place's slot allocation plus the mutable recycle-lag clock shared by its slots. */
interface PlaceState {
	lastCompletionMs: number;
	place: TaskPoolPlace;
}

/**
 * Drive a replenishing pool of long-lived tasks across a configurable list of
 * places: spread `concurrency` slots across the places (capped at
 * {@link MAX_TASKS_PER_PLACE} each), keep every slot full, relaunch a slot when
 * its task returns while work remains (`!isDone()`), and resolve once every slot
 * has drained and the done-signal has fired. All places drain the consumer's one
 * shared queue, so a slot that frees on a fast place transparently re-runs a
 * sibling's lost work. The pool is jest/mutation-agnostic — chunk sizing, result
 * de-duplication, and bail live in the consumer.
 *
 * A task that throws a recognised platform backoff signal (a genuinely-full
 * place's `RESOURCE_EXHAUSTED`, the ~10s slot-recycle lag, or a rate-limit 429)
 * waits the slot out and retries without surfacing an error; any other throw
 * frees the slot (its in-flight work re-surfaces via the queue invisibility
 * window), reports through `onError`, and is relaunched while work remains — so
 * neither a transient failure nor platform backoff aborts the run or corrupts
 * results.
 */
export async function runTaskPool(options: TaskPoolOptions): Promise<void> {
	const { concurrency, isDone, onError, onResult, places } = options;

	if (concurrency < 1) {
		throw new Error(`runTaskPool concurrency must be >= 1, got ${String(concurrency)}`);
	}

	if (places.length === 0) {
		throw new Error("runTaskPool requires at least one place");
	}

	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? delay;
	const warn =
		options.warn ??
		((message: string): void => {
			console.warn(message);
		});

	const allocations = distributeSlots(places, concurrency, warn);

	async function backoff(state: PlaceState, retryAfterMs: number | undefined): Promise<void> {
		// A non-positive server retry-after (e.g. a 429 carrying `retry-after:
		// 0`) would spin into a tight retry loop, so fall back to the default
		// delay.
		const genuineMs =
			retryAfterMs !== undefined && retryAfterMs > 0 ? retryAfterMs : DEFAULT_BACKOFF_MS;
		// Negative infinity until the first completion, so a startup backoff is
		// always read as genuine rather than recycle lag.
		const sinceCompletion = now() - state.lastCompletionMs;
		const waitMs =
			sinceCompletion < RECYCLE_LAG_MS ? RECYCLE_LAG_MS - sinceCompletion : genuineMs;
		await sleep(waitMs);
	}

	async function worker(state: PlaceState): Promise<void> {
		while (!isDone()) {
			let result: ScriptResult;
			try {
				result = await state.place.runTask();
			} catch (err) {
				const signal = classifyBackoff(err);
				if (signal !== undefined) {
					await backoff(state, signal.retryAfterMs);
					continue;
				}

				onError?.(err);
				continue;
			}

			// Tracks slot-recycle lag (a backoff signal right after a completion)
			// versus a genuinely-full place, per place across its slots.
			state.lastCompletionMs = now();
			onResult(result);
		}
	}

	const workers: Array<Promise<void>> = [];
	for (const { place, slots } of allocations) {
		const state: PlaceState = { lastCompletionMs: Number.NEGATIVE_INFINITY, place };
		for (let slot = 0; slot < slots; slot += 1) {
			workers.push(worker(state));
		}
	}

	await Promise.all(workers);
}

/**
 * Spread `concurrency` task-slots across the places as evenly as possible, capped
 * at {@link MAX_TASKS_PER_PLACE} per place. A total above the aggregate ceiling is
 * clamped and reported once through `warn` so the run still proceeds at the real
 * capacity instead of silently over-subscribing.
 */
function distributeSlots(
	places: ReadonlyArray<TaskPoolPlace>,
	concurrency: number,
	warn: (message: string) => void,
): Array<{ place: TaskPoolPlace; slots: number }> {
	const placeCount = places.length;
	const capacity = placeCount * MAX_TASKS_PER_PLACE;
	if (concurrency > capacity) {
		warn(
			`runTaskPool concurrency ${String(concurrency)} exceeds ${String(placeCount)} ` +
				`place(s) × ${String(MAX_TASKS_PER_PLACE)} = ${String(capacity)}; ` +
				`clamping to ${String(capacity)}`,
		);
	}

	const effective = Math.min(concurrency, capacity);
	const base = Math.floor(effective / placeCount);
	const remainder = effective % placeCount;
	return places.map((place, index) => ({ place, slots: base + (index < remainder ? 1 : 0) }));
}

/**
 * Classify the platform backoff signal the pool waits out rather than failing:
 * a rate-limit 429 ({@link RateLimitError}, carrying the server retry delay) or a
 * genuinely-full place ({@link ApiError} with the `RESOURCE_EXHAUSTED` code).
 * Walks the `cause` chain because {@link RemoteRunner.executeScript} wraps the
 * transport error in a plain `Error`. Any other error is not a backoff signal.
 */
function classifyBackoff(error: unknown): BackoffSignal | undefined {
	for (let current: unknown = error; current instanceof Error; current = current.cause) {
		if (current instanceof RateLimitError) {
			return { retryAfterMs: current.retryAfterSeconds * 1000 };
		}

		if (current instanceof ApiError && current.code === "RESOURCE_EXHAUSTED") {
			return {};
		}
	}

	return undefined;
}
