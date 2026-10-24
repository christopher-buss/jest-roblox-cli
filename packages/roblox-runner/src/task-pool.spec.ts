import { ApiError, RateLimitError } from "@bedrock-rbx/ocale";

import { describe, expect, it, vi } from "vitest";

import type { ScriptResult } from "./runner-types.ts";
import { runTaskPoolAsync } from "./task-pool.ts";
import type { TaskPoolBackoff, TaskPoolPlace } from "./task-pool.ts";

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
	return {
		durationMs: 1,
		outputs,
		terminalTask: {
			ref: { sessionId: "session-1", taskId: "task-1" },
			state: "COMPLETE",
		},
	};
}

function makeQueueDrainingTask(queue: Array<string>): () => Promise<ScriptResult> {
	return async () => makeScriptResult([queue.shift() ?? EMPTY_MARKER]);
}

function makeSharedQueuePlace({
	placeCalls,
	placeIndex,
	queue,
}: {
	placeCalls: Array<number>;
	placeIndex: number;
	queue: Array<string>;
}): TaskPoolPlace {
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

function makeThrowingTask({
	counter,
	makeError,
	throwingAttempt,
}: {
	counter: AttemptCounter;
	makeError: () => TaskRejection;
	throwingAttempt: number;
}): () => Promise<ScriptResult> {
	return async () => {
		counter.attempt += 1;
		if (counter.attempt === throwingAttempt) {
			// oxlint-disable-next-line typescript/only-throw-error -- fixture exercises normalization of non-Error rejections
			throw makeError();
		}

		return makeScriptResult();
	};
}

function throwOnceThenSucceed(
	counter: AttemptCounter,
	error: TaskRejection,
): () => Promise<ScriptResult> {
	return makeThrowingTask({ counter, makeError: () => error, throwingAttempt: 1 });
}

describe(runTaskPoolAsync, () => {
	it("should fill to concurrency on start", async () => {
		expect.assertions(2);

		const { pending, runTask } = makePendingTask();

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

		const { pending, runTask } = makePendingTask();

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

		const { pending, runTask } = makePendingTask();

		let isDone = false;
		const pool = runTaskPoolAsync({
			concurrency: 1,
			isDone: () => isDone,
			onResult: () => {},
			places: [{ runTask }],
		});

		expect(runTask).toHaveBeenCalledExactlyOnceWith(0);

		pending[0]!.resolve(makeScriptResult());
		await flushAsync();

		expect(runTask).toHaveBeenCalledTimes(2);

		isDone = true;
		pending[1]!.resolve(makeScriptResult());

		await expect(pool).resolves.toBeUndefined();
	});

	it("should stop launching once done and resolve after in-flight settle", async () => {
		expect.assertions(2);

		const { pending, runTask } = makePendingTask();

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
		expect.assertions(1);

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

		expect(onError).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				cause: rejection,
				message: "Task failed with a non-Error rejection",
			}),
			0,
		);
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

	it("should skip a launch while the consumer reports the remaining work covered", async () => {
		expect.assertions(4);

		const { pending, runTask } = makePendingTask();
		const isWorkCovered = vi.fn<(liveTasks: number) => boolean>((liveTasks) => liveTasks >= 1);

		let isDone = false;
		const pool = runTaskPoolAsync({
			concurrency: 3,
			isDone: () => isDone,
			isWorkCovered,
			onResult: () => {},
			places: [{ runTask }],
		});

		expect(runTask).toHaveBeenCalledOnce();

		await flushAsync();

		expect(isWorkCovered).toHaveBeenCalledTimes(2);

		pending[0]!.resolve(makeScriptResult());
		await flushAsync();

		expect(runTask).toHaveBeenCalledTimes(2);

		isDone = true;
		pending[1]!.resolve(makeScriptResult());
		await pool;

		expect(isWorkCovered).not.toHaveBeenCalledWith(0);
	});

	it("should launch while covered when no task is live", async () => {
		expect.assertions(2);

		const counter = { attempt: 0 };
		const runTask = vi.fn<(slot: number) => Promise<ScriptResult>>(async () => {
			counter.attempt += 1;
			return makeScriptResult();
		});

		await runTaskPoolAsync({
			concurrency: 2,
			isDone: () => counter.attempt >= 3,
			isWorkCovered: () => true,
			onResult: () => {},
			places: [{ runTask }],
		});

		expect(runTask).toHaveBeenCalledTimes(3);
		expect(runTask.mock.calls).toStrictEqual([[0], [0], [0]]);
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
				makeSharedQueuePlace({ placeCalls, placeIndex: 0, queue }),
				makeSharedQueuePlace({ placeCalls, placeIndex: 1, queue }),
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
		expect(warn).toHaveBeenCalledExactlyOnceWith(
			"runTaskPool concurrency 25 exceeds 2 place(s) × 10 = 20; clamping to 20",
		);
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

		expect(consoleWarn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("exceeds"));
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
		expect(sleep).toHaveBeenCalledExactlyOnceWith(7000, undefined);
		expect(onError).not.toHaveBeenCalled();
	});

	it("should end a backoff wait once the signal aborts", async () => {
		expect.assertions(2);

		const controller = new AbortController();
		const runTask = vi.fn<() => Promise<ScriptResult>>(async () => {
			throw new RateLimitError("slow down", { retryAfterSeconds: 600 });
		});

		const pool = runTaskPoolAsync({
			concurrency: 1,
			isDone: () => controller.signal.aborted,
			now: () => 0,
			onResult: () => {},
			places: [{ runTask }],
			signal: controller.signal,
		});
		await flushAsync();
		controller.abort();

		await expect(pool).resolves.toBeUndefined();
		expect(runTask).toHaveBeenCalledOnce();
	});

	it("should surface a backoff sleep failure that is not an abort", async () => {
		expect.assertions(1);

		const controller = new AbortController();
		const runTask = vi.fn<() => Promise<ScriptResult>>(async () => {
			throw new RateLimitError("slow down", { retryAfterSeconds: 7 });
		});

		const pool = runTaskPoolAsync({
			concurrency: 1,
			isDone: () => false,
			now: () => 0,
			onResult: () => {},
			places: [{ runTask }],
			signal: controller.signal,
			sleep: async () => {
				throw new Error("timer broke");
			},
		});

		await expect(pool).rejects.toThrow("timer broke");
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

		await runRetryPoolAsync({ counter, runTask, sleep });

		expect(runTask).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledExactlyOnceWith(5000, undefined);
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

		await runRetryPoolAsync({ counter, runTask, sleep });

		expect(runTask).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledExactlyOnceWith(5000, undefined);
	});

	it.for([
		{ elapsedMs: 2000, expectedWaitMs: 8000 },
		{ elapsedMs: 10000, expectedWaitMs: 30000 },
	])("should bound the recycle window: %j", async ({ elapsedMs, expectedWaitMs }) => {
		expect.assertions(2);

		const counter = { attempt: 0 };
		const clock = { ms: 0 };
		const runTask = vi.fn<() => Promise<ScriptResult>>(
			makeThrowingTask({
				counter,
				makeError: () => {
					clock.ms = elapsedMs;
					return new RateLimitError("slow down", { retryAfterSeconds: 30 });
				},
				throwingAttempt: 2,
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
		expect(sleep).toHaveBeenCalledExactlyOnceWith(expectedWaitMs, undefined);
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

		await runRetryPoolAsync({ counter, runTask, sleep });

		expect(runTask).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledExactlyOnceWith(3000, undefined);
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

const EMPTY_MARKER = "EMPTY";

async function flushAsync(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function hasEvery(seen: ReadonlySet<string>, entries: ReadonlyArray<string>): boolean {
	return entries.every((entry) => seen.has(entry));
}

function makePendingTask() {
	const pending: Array<Deferred> = [];
	const runTask = vi.fn<() => Promise<ScriptResult>>(async () => {
		const deferred = makeDeferred();
		pending.push(deferred);
		return deferred.promise;
	});
	return { pending, runTask };
}

async function runRetryPoolAsync({
	counter,
	runTask,
	sleep,
}: {
	counter: AttemptCounter;
	runTask: () => Promise<ScriptResult>;
	sleep: (ms: number) => Promise<void>;
}): Promise<void> {
	await runTaskPoolAsync({
		concurrency: 1,
		isDone: () => counter.attempt >= 2,
		now: () => 0,
		onResult: () => {},
		places: [{ runTask }],
		sleep,
	});
}

describe("pool boundaries", () => {
	it("should avoid warning when requested concurrency exactly equals place capacity", () => {
		expect.assertions(2);

		const runTask = vi.fn<() => Promise<ScriptResult>>(async () => makeDeferred().promise);
		const warn = vi.fn<(message: string) => void>();
		void runTaskPoolAsync({
			concurrency: 10,
			isDone: () => false,
			onResult: () => {},
			places: [{ runTask }],
			warn,
		});

		expect(runTask).toHaveBeenCalledTimes(10);
		expect(warn).not.toHaveBeenCalled();
	});
});

describe("failed task backpressure", () => {
	it("should free failed work before deciding whether another launch is covered", async () => {
		expect.assertions(2);

		const pending = makeDeferred();
		const runTask = vi
			.fn<() => Promise<ScriptResult>>()
			.mockRejectedValueOnce(new Error("failed"))
			.mockImplementation(async () => pending.promise);
		let isDone = false;
		const pool = runTaskPoolAsync({
			concurrency: 1,
			isDone: () => isDone,
			isWorkCovered: (live) => live >= 1,
			onResult: () => {
				isDone = true;
			},
			places: [{ runTask }],
		});
		await flushAsync();

		expect(runTask).toHaveBeenCalledTimes(2);

		pending.resolve(makeScriptResult());

		await expect(pool).resolves.toBeUndefined();
	});
});
