import { ApiError, RateLimitError } from "@bedrock-rbx/ocale";

import { describe, expect, it, vi } from "vitest";

import { runTaskPoolAsync } from "./task-pool.ts";
import type { TaskPoolBackoff, TaskPoolPlace } from "./task-pool.ts";
import type { ScriptResult } from "./types.ts";

/** Envelope a task returns when it finds the shared queue already drained. */
const EMPTY_MARKER = "EMPTY";

/**
 * What a pool task rejects with. The pool surfaces an `Error` as-is and
 * normalizes anything else into one, carrying the original as `cause` — the
 * plain-object arm is what drives that second path.
 */
type TaskRejection = Error | { readonly code: string };

interface AttemptCounter {
	attempt: number;
}

interface Deferred {
	promise: Promise<ScriptResult>;
	reject: (error: unknown) => void;
	resolve: (result: ScriptResult) => void;
}

function makeDeferred(): Deferred {
	let resolvePromise!: (result: ScriptResult) => void;
	let rejectPromise!: (error: unknown) => void;
	const promise = new Promise<ScriptResult>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	return { promise, reject: rejectPromise, resolve: resolvePromise };
}

function makeScriptResult(outputs: Array<string> = ["[]"]): ScriptResult {
	return { durationMs: 1, outputs };
}

/** Flush the microtask queue so settled-task continuations run. */
async function flushAsync(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function hasEvery(seen: ReadonlySet<string>, entries: ReadonlyArray<string>): boolean {
	return entries.every((entry) => seen.has(entry));
}

/** A task that hands out the next queued item, or {@link EMPTY_MARKER}. */
function makeQueueDrainingTask(queue: Array<string>): () => Promise<ScriptResult> {
	return async () => makeScriptResult([queue.shift() ?? EMPTY_MARKER]);
}

/** A place drawing from `queue`, tallying its launches in `placeCalls`. */
function makeSharedQueuePlace(
	queue: Array<string>,
	placeCalls: Array<number>,
	placeIndex: number,
): TaskPoolPlace {
	const drainAsync = makeQueueDrainingTask(queue);
	return {
		runTask: async () => {
			placeCalls[placeIndex] = (placeCalls[placeIndex] ?? 0) + 1;
			return drainAsync();
		},
	};
}

function makeNonEmptyCollector(processed: Array<string>): (result: ScriptResult) => void {
	return (result) => {
		const item = result.outputs[0]!;
		if (item !== EMPTY_MARKER) {
			processed.push(item);
		}
	};
}

/** A task throwing on `throwingAttempt`, returning an envelope after. */
function makeThrowingTask(
	counter: AttemptCounter,
	throwingAttempt: number,
	makeError: () => TaskRejection,
): () => Promise<ScriptResult> {
	return async () => {
		counter.attempt += 1;
		if (counter.attempt === throwingAttempt) {
			// A non-Error rejection is one of the cases the pool normalizes.
			// eslint-disable-next-line ts/only-throw-error -- see above
			throw makeError();
		}

		return makeScriptResult();
	};
}

function throwOnceThenSucceed(
	counter: AttemptCounter,
	error: TaskRejection,
): () => Promise<ScriptResult> {
	return makeThrowingTask(counter, 1, () => error);
}

describe(runTaskPoolAsync, () => {
	it("should fill to concurrency on start", async () => {
		expect.assertions(2);

		const pending: Array<Deferred> = [];
		const runTask = vi.fn<() => Promise<ScriptResult>>(async () => {
			const deferred = makeDeferred();
			pending.push(deferred);
			return deferred.promise;
		});

		let isDone = false;
		const pool = runTaskPoolAsync({
			concurrency: 3,
			isDone: () => isDone,
			onResult: () => {},
			places: [{ runTask }],
		});

		expect(runTask).toHaveBeenCalledTimes(3);

		isDone = true;
		for (const deferred of pending) {
			deferred.resolve(makeScriptResult());
		}

		await expect(pool).resolves.toBeUndefined();
	});

	it("should report each settled task under its own stable slot index", async () => {
		expect.assertions(2);

		const pending: Array<Deferred> = [];
		const runTask = vi.fn<() => Promise<ScriptResult>>(async () => {
			const deferred = makeDeferred();
			pending.push(deferred);
			return deferred.promise;
		});

		const slots: Array<number> = [];
		let isDone = false;
		const pool = runTaskPoolAsync({
			concurrency: 2,
			isDone: () => isDone,
			onResult: (_result, slot) => {
				slots.push(slot);
			},
			places: [{ runTask }],
		});

		// Slot 1 settles twice while slot 0 is still in flight: a consumer
		// bounding no-progress must be able to see that one slot delivered
		// everything, not two.
		pending[1]!.resolve(makeScriptResult());
		await flushAsync();
		pending[2]!.resolve(makeScriptResult());
		await flushAsync();

		expect(slots).toStrictEqual([1, 1]);

		isDone = true;
		pending[0]!.resolve(makeScriptResult());
		pending[3]!.resolve(makeScriptResult());

		await expect(pool).resolves.toBeUndefined();
	});

	it("should relaunch a slot when a task returns while work remains", async () => {
		expect.assertions(3);

		const pending: Array<Deferred> = [];
		const runTask = vi.fn<() => Promise<ScriptResult>>(async () => {
			const deferred = makeDeferred();
			pending.push(deferred);
			return deferred.promise;
		});

		let isDone = false;
		const pool = runTaskPoolAsync({
			concurrency: 1,
			isDone: () => isDone,
			onResult: () => {},
			places: [{ runTask }],
		});

		expect(runTask).toHaveBeenCalledOnce();

		pending[0]!.resolve(makeScriptResult());
		await flushAsync();

		expect(runTask).toHaveBeenCalledTimes(2);

		isDone = true;
		pending[1]!.resolve(makeScriptResult());

		await expect(pool).resolves.toBeUndefined();
	});

	it("should stop launching once done and resolve after in-flight settle", async () => {
		expect.assertions(2);

		const pending: Array<Deferred> = [];
		const runTask = vi.fn<() => Promise<ScriptResult>>(async () => {
			const deferred = makeDeferred();
			pending.push(deferred);
			return deferred.promise;
		});

		let isDone = false;
		const pool = runTaskPoolAsync({
			concurrency: 2,
			isDone: () => isDone,
			onResult: () => {
				isDone = true;
			},
			places: [{ runTask }],
		});

		// The first settled task flips the done-signal; the pool must not
		// relaunch.
		pending[0]!.resolve(makeScriptResult());
		pending[1]!.resolve(makeScriptResult());
		await pool;

		expect(runTask).toHaveBeenCalledTimes(2);
		expect(isDone).toBeTrue();
	});

	it("should fold every settled task's envelope", async () => {
		expect.assertions(1);

		// Eager relaunch means slots may over-launch past the real work; those
		// tasks find an empty queue and return a benign empty envelope. What the
		// pool guarantees is that every settled envelope is folded.
		const expected = ["a", "b", "c"];
		const work = [...expected];
		const runTask = vi.fn<() => Promise<ScriptResult>>(makeQueueDrainingTask(work));

		const seen = new Set<string>();
		await runTaskPoolAsync({
			concurrency: 3,
			isDone: () => hasEvery(seen, expected),
			onResult: (result) => {
				seen.add(result.outputs[0]!);
			},
			places: [{ runTask }],
		});

		expect(hasEvery(seen, expected)).toBeTrue();
	});

	it("should free and relaunch a slot when a task throws, surfacing the error", async () => {
		expect.assertions(2);

		const counter = { attempt: 0 };
		const runTask = vi.fn<() => Promise<ScriptResult>>(
			throwOnceThenSucceed(counter, new Error("transient")),
		);

		const errors: Array<string> = [];
		await runTaskPoolAsync({
			concurrency: 1,
			isDone: () => counter.attempt >= 2,
			onError: (error) => {
				errors.push(error.message);
			},
			onResult: () => {},
			places: [{ runTask }],
		});

		expect(runTask).toHaveBeenCalledTimes(2);
		expect(errors[0]).toBe("transient");
	});

	it("should normalize a non-Error task rejection before surfacing it", async () => {
		expect.assertions(3);

		const counter = { attempt: 0 };
		const rejection = { code: "transient" };
		const runTask = vi.fn<() => Promise<ScriptResult>>(
			throwOnceThenSucceed(counter, rejection),
		);
		const onError = vi.fn<(error: Error) => void>();

		await runTaskPoolAsync({
			concurrency: 1,
			isDone: () => counter.attempt >= 2,
			onError,
			onResult: () => {},
			places: [{ runTask }],
		});

		expect(onError).toHaveBeenCalledOnce();

		const error = onError.mock.calls[0]![0];

		expect(error.message).toBe("Task failed with a non-Error rejection");
		expect(error.cause).toBe(rejection);
	});

	it("should swallow a task error when no onError handler is provided", async () => {
		expect.assertions(1);

		const counter = { attempt: 0 };
		const runTask = vi.fn<() => Promise<ScriptResult>>(
			throwOnceThenSucceed(counter, new Error("transient")),
		);

		await expect(
			runTaskPoolAsync({
				concurrency: 1,
				isDone: () => counter.attempt >= 2,
				onResult: () => {},
				places: [{ runTask }],
			}),
		).resolves.toBeUndefined();
	});

	it("should reject a non-positive concurrency", async () => {
		expect.assertions(1);

		const runTask = vi.fn<() => Promise<ScriptResult>>(async () => makeScriptResult());

		await expect(
			runTaskPoolAsync({
				concurrency: 0,
				isDone: () => false,
				onResult: () => {},
				places: [{ runTask }],
			}),
		).rejects.toThrow(/concurrency must be >= 1/);
	});

	it("should reject an empty place list", async () => {
		expect.assertions(1);

		await expect(
			runTaskPoolAsync({
				concurrency: 1,
				isDone: () => false,
				onResult: () => {},
				places: [],
			}),
		).rejects.toThrow(/at least one place/);
	});

	it("should launch nothing when work is already done at start", async () => {
		expect.assertions(1);

		const runTask = vi.fn<() => Promise<ScriptResult>>(async () => makeScriptResult());
		await runTaskPoolAsync({
			concurrency: 4,
			isDone: () => true,
			onResult: () => {},
			places: [{ runTask }],
		});

		expect(runTask).not.toHaveBeenCalled();
	});
});

describe("runTaskPool multi-place fan-out", () => {
	it("should drain one shared queue exactly-once across places", async () => {
		expect.assertions(3);

		const queue = ["w0", "w1", "w2", "w3", "w4", "w5"];
		const placeCalls = [0, 0];

		const processed: Array<string> = [];
		await runTaskPoolAsync({
			concurrency: 4,
			isDone: () => queue.length === 0,
			onResult: makeNonEmptyCollector(processed),
			places: [
				makeSharedQueuePlace(queue, placeCalls, 0),
				makeSharedQueuePlace(queue, placeCalls, 1),
			],
		});

		expect(processed.toSorted()).toStrictEqual(["w0", "w1", "w2", "w3", "w4", "w5"]);

		const uniqueProcessed = new Set(processed);

		expect(uniqueProcessed.size).toBe(processed.length);
		expect(placeCalls[0]! > 0 && placeCalls[1]! > 0).toBeTrue();
	});

	it("should distribute concurrency unevenly, the remainder going to earlier places", () => {
		expect.assertions(2);

		const runTaskA = vi.fn<() => Promise<ScriptResult>>(async () => makeDeferred().promise);
		const runTaskB = vi.fn<() => Promise<ScriptResult>>(async () => makeDeferred().promise);

		// 5 slots across 2 places ⇒ ⌊5/2⌋ = 2 each, remainder 1 to the first.
		void runTaskPoolAsync({
			concurrency: 5,
			isDone: () => false,
			onResult: () => {},
			places: [{ runTask: runTaskA }, { runTask: runTaskB }],
		});

		expect(runTaskA).toHaveBeenCalledTimes(3);
		expect(runTaskB).toHaveBeenCalledTimes(2);
	});

	it("should clamp an over-capacity total to 10 per place and warn once", () => {
		expect.assertions(3);

		const runTaskA = vi.fn<() => Promise<ScriptResult>>(async () => makeDeferred().promise);
		const runTaskB = vi.fn<() => Promise<ScriptResult>>(async () => makeDeferred().promise);
		const warn = vi.fn<(message: string) => void>();

		void runTaskPoolAsync({
			concurrency: 25,
			isDone: () => false,
			onResult: () => {},
			places: [{ runTask: runTaskA }, { runTask: runTaskB }],
			warn,
		});

		expect(runTaskA).toHaveBeenCalledTimes(10);
		expect(runTaskB).toHaveBeenCalledTimes(10);
		expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("exceeds"));
	});

	it("should warn through console.warn by default", () => {
		expect.assertions(1);

		const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const runTask = vi.fn<() => Promise<ScriptResult>>(async () => makeDeferred().promise);

		void runTaskPoolAsync({
			concurrency: 50,
			isDone: () => false,
			onResult: () => {},
			places: [{ runTask }],
		});

		expect(consoleWarn).toHaveBeenCalledOnce();
	});
});

describe("runTaskPool backoff", () => {
	it("should back off a rate-limit 429 by the server retry delay and retry", async () => {
		expect.assertions(3);

		const counter = { attempt: 0 };
		const runTask = vi.fn<() => Promise<ScriptResult>>(
			throwOnceThenSucceed(
				counter,
				new RateLimitError("slow down", { retryAfterSeconds: 7 }),
			),
		);
		const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue();
		const onError = vi.fn<(error: Error) => void>();

		await runTaskPoolAsync({
			concurrency: 1,
			isDone: () => counter.attempt >= 2,
			now: () => 0,
			onError,
			onResult: () => {},
			places: [{ runTask }],
			sleep,
		});

		expect(runTask).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledExactlyOnceWith(7000);
		expect(onError).not.toHaveBeenCalled();
	});

	it("should floor a zero retry-after to the default delay, not spin", async () => {
		expect.assertions(2);

		const counter = { attempt: 0 };
		// A 429 with retry-after 0 must not yield a sleep(0) tight loop.
		const runTask = vi.fn<() => Promise<ScriptResult>>(
			throwOnceThenSucceed(
				counter,
				new RateLimitError("slow down", { retryAfterSeconds: 0 }),
			),
		);
		const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue();

		await runTaskPoolAsync({
			concurrency: 1,
			isDone: () => counter.attempt >= 2,
			now: () => 0,
			onResult: () => {},
			places: [{ runTask }],
			sleep,
		});

		expect(runTask).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledExactlyOnceWith(5000);
	});

	it("should back off a genuinely-full place by the default delay and retry", async () => {
		expect.assertions(2);

		const counter = { attempt: 0 };
		const runTask = vi.fn<() => Promise<ScriptResult>>(
			throwOnceThenSucceed(
				counter,
				new ApiError("full", { code: "RESOURCE_EXHAUSTED", statusCode: 429 }),
			),
		);
		const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue();

		await runTaskPoolAsync({
			concurrency: 1,
			isDone: () => counter.attempt >= 2,
			now: () => 0,
			onResult: () => {},
			places: [{ runTask }],
			sleep,
		});

		expect(runTask).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledExactlyOnceWith(5000);
	});

	it("should treat a backoff signal right after a completion as recycle lag, not place-full", async () => {
		expect.assertions(2);

		const counter = { attempt: 0 };
		const clock = { ms: 0 };
		const runTask = vi.fn<() => Promise<ScriptResult>>(
			makeThrowingTask(counter, 2, () => {
				// 2s after the first task completed (at clock 0): inside the ~10s
				// recycle window, so the long server retry-after must NOT win.
				clock.ms = 2000;
				return new RateLimitError("slow down", { retryAfterSeconds: 30 });
			}),
		);
		const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue();

		await runTaskPoolAsync({
			concurrency: 1,
			isDone: () => counter.attempt >= 3,
			now: () => clock.ms,
			onResult: () => {},
			places: [{ runTask }],
			sleep,
		});

		expect(runTask).toHaveBeenCalledTimes(3);
		// Recycle remainder (10s − 2s elapsed), not the 30s rate-limit delay.
		expect(sleep).toHaveBeenCalledExactlyOnceWith(8000);
	});

	it("should unwrap a backoff signal carried on the error cause chain", async () => {
		expect.assertions(2);

		const counter = { attempt: 0 };
		const runTask = vi.fn<() => Promise<ScriptResult>>(
			throwOnceThenSucceed(
				counter,
				new Error("execute failed", {
					cause: new RateLimitError("slow down", { retryAfterSeconds: 3 }),
				}),
			),
		);
		const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue();

		await runTaskPoolAsync({
			concurrency: 1,
			isDone: () => counter.attempt >= 2,
			now: () => 0,
			onResult: () => {},
			places: [{ runTask }],
			sleep,
		});

		expect(runTask).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledExactlyOnceWith(3000);
	});

	it("should surface an API error it does not back off on rather than backing off", async () => {
		expect.assertions(3);

		const counter = { attempt: 0 };
		const apiError = new ApiError("not found", { code: "NotFound", statusCode: 404 });
		const runTask = vi.fn<() => Promise<ScriptResult>>(throwOnceThenSucceed(counter, apiError));
		const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue();
		const onError = vi.fn<(error: Error) => void>();

		await runTaskPoolAsync({
			concurrency: 1,
			isDone: () => counter.attempt >= 2,
			onError,
			onResult: () => {},
			places: [{ runTask }],
			sleep,
		});

		expect(runTask).toHaveBeenCalledTimes(2);
		expect(onError).toHaveBeenCalledExactlyOnceWith(apiError, 0);
		expect(sleep).not.toHaveBeenCalled();
	});

	it("should report a rate-limit wait to the backoff observer", async () => {
		expect.assertions(1);

		const counter = { attempt: 0 };
		const runTask = vi.fn<() => Promise<ScriptResult>>(
			throwOnceThenSucceed(
				counter,
				new RateLimitError("slow down", { retryAfterSeconds: 7 }),
			),
		);
		const onBackoff = vi.fn<(event: TaskPoolBackoff) => void>();

		await runTaskPoolAsync({
			concurrency: 1,
			isDone: () => counter.attempt >= 2,
			now: () => 0,
			onBackoff,
			onResult: () => {},
			places: [{ runTask }],
			sleep: async () => {},
		});

		expect(onBackoff).toHaveBeenCalledExactlyOnceWith({
			kind: "rate-limit",
			placeIndex: 0,
			slot: 0,
			waitMs: 7000,
		});
	});

	it("should report a full place to the backoff observer under the place it came from", async () => {
		expect.assertions(1);

		const counter = { attempt: 0 };
		// Slot 0 keeps the pool's other place busy without touching `counter`, so
		// only the full place's attempts decide when the run is done.
		const spare: TaskPoolPlace = { runTask: async () => makeScriptResult([EMPTY_MARKER]) };
		const full: TaskPoolPlace = {
			runTask: throwOnceThenSucceed(
				counter,
				new ApiError("full", { code: "RESOURCE_EXHAUSTED", statusCode: 429 }),
			),
		};
		const onBackoff = vi.fn<(event: TaskPoolBackoff) => void>();

		await runTaskPoolAsync({
			concurrency: 2,
			isDone: () => counter.attempt >= 2,
			now: () => 0,
			onBackoff,
			onResult: () => {},
			places: [spare, full],
			sleep: async () => {},
		});

		expect(onBackoff).toHaveBeenCalledExactlyOnceWith({
			kind: "place-full",
			placeIndex: 1,
			slot: 1,
			waitMs: 5000,
		});
	});
});
