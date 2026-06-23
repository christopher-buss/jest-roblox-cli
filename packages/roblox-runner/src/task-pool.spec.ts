import { ApiError, RateLimitError } from "@bedrock-rbx/ocale";

import { describe, expect, it, vi } from "vitest";

import { runTaskPool } from "./task-pool.ts";
import type { ScriptResult } from "./types.ts";

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
async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe(runTaskPool, () => {
	it("should fill to concurrency on start", async () => {
		expect.assertions(1);

		const pending: Array<Deferred> = [];
		const runTask = vi.fn<() => Promise<ScriptResult>>(async () => {
			const deferred = makeDeferred();
			pending.push(deferred);
			return deferred.promise;
		});

		let done = false;
		const pool = runTaskPool({
			concurrency: 3,
			isDone: () => done,
			onResult: () => {},
			places: [{ runTask }],
		});

		expect(runTask).toHaveBeenCalledTimes(3);

		done = true;
		for (const deferred of pending) {
			deferred.resolve(makeScriptResult());
		}

		await pool;
	});

	it("should relaunch a slot when a task returns while work remains", async () => {
		expect.assertions(2);

		const pending: Array<Deferred> = [];
		const runTask = vi.fn<() => Promise<ScriptResult>>(async () => {
			const deferred = makeDeferred();
			pending.push(deferred);
			return deferred.promise;
		});

		let done = false;
		const pool = runTaskPool({
			concurrency: 1,
			isDone: () => done,
			onResult: () => {},
			places: [{ runTask }],
		});

		expect(runTask).toHaveBeenCalledOnce();

		pending[0]!.resolve(makeScriptResult());
		await flush();

		expect(runTask).toHaveBeenCalledTimes(2);

		done = true;
		pending[1]!.resolve(makeScriptResult());
		await pool;
	});

	it("should stop launching once done and resolve after in-flight settle", async () => {
		expect.assertions(2);

		const pending: Array<Deferred> = [];
		const runTask = vi.fn<() => Promise<ScriptResult>>(async () => {
			const deferred = makeDeferred();
			pending.push(deferred);
			return deferred.promise;
		});

		let done = false;
		const pool = runTaskPool({
			concurrency: 2,
			isDone: () => done,
			onResult: () => {
				done = true;
			},
			places: [{ runTask }],
		});

		// The first settled task flips the done-signal; the pool must not
		// relaunch.
		pending[0]!.resolve(makeScriptResult());
		pending[1]!.resolve(makeScriptResult());
		await pool;

		expect(runTask).toHaveBeenCalledTimes(2);
		expect(done).toBeTrue();
	});

	it("should fold every settled task's envelope", async () => {
		expect.assertions(1);

		// Eager relaunch means slots may over-launch past the real work; those
		// tasks find an empty queue and return a benign empty envelope. What the
		// pool guarantees is that every settled envelope is folded.
		const work = ["a", "b", "c"];
		const runTask = vi.fn<() => Promise<ScriptResult>>(async () => {
			return makeScriptResult([work.shift() ?? "[]"]);
		});

		const seen = new Set<string>();
		await runTaskPool({
			concurrency: 3,
			isDone: () => seen.has("a") && seen.has("b") && seen.has("c"),
			onResult: (result) => {
				seen.add(result.outputs[0]!);
			},
			places: [{ runTask }],
		});

		expect(["a", "b", "c"].every((entry) => seen.has(entry))).toBeTrue();
	});

	it("should free and relaunch a slot when a task throws, surfacing the error", async () => {
		expect.assertions(2);

		let attempt = 0;
		const runTask = vi.fn<() => Promise<ScriptResult>>(async () => {
			attempt += 1;
			if (attempt === 1) {
				throw new Error("transient");
			}

			return makeScriptResult();
		});

		const errors: Array<string> = [];
		await runTaskPool({
			concurrency: 1,
			isDone: () => attempt >= 2,
			onError: (error) => {
				errors.push(error instanceof Error ? error.message : String(error));
			},
			onResult: () => {},
			places: [{ runTask }],
		});

		expect(runTask).toHaveBeenCalledTimes(2);
		expect(errors[0]).toBe("transient");
	});

	it("should swallow a task error when no onError handler is provided", async () => {
		expect.assertions(1);

		let attempt = 0;
		const runTask = vi.fn<() => Promise<ScriptResult>>(async () => {
			attempt += 1;
			if (attempt === 1) {
				throw new Error("transient");
			}

			return makeScriptResult();
		});

		await expect(
			runTaskPool({
				concurrency: 1,
				isDone: () => attempt >= 2,
				onResult: () => {},
				places: [{ runTask }],
			}),
		).resolves.toBeUndefined();
	});

	it("should reject a non-positive concurrency", async () => {
		expect.assertions(1);

		const runTask = vi.fn<() => Promise<ScriptResult>>(async () => makeScriptResult());

		await expect(
			runTaskPool({
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
			runTaskPool({ concurrency: 1, isDone: () => false, onResult: () => {}, places: [] }),
		).rejects.toThrow(/at least one place/);
	});

	it("should launch nothing when work is already done at start", async () => {
		expect.assertions(1);

		const runTask = vi.fn<() => Promise<ScriptResult>>(async () => makeScriptResult());
		await runTaskPool({
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
		function makePlace(placeIndex: number): { runTask: () => Promise<ScriptResult> } {
			return {
				runTask: async (): Promise<ScriptResult> => {
					placeCalls[placeIndex] = (placeCalls[placeIndex] ?? 0) + 1;
					const item = queue.shift();
					return makeScriptResult([item ?? "EMPTY"]);
				},
			};
		}

		const processed: Array<string> = [];
		await runTaskPool({
			concurrency: 4,
			isDone: () => queue.length === 0,
			onResult: (result) => {
				const item = result.outputs[0]!;
				if (item !== "EMPTY") {
					processed.push(item);
				}
			},
			places: [makePlace(0), makePlace(1)],
		});

		expect([...processed].sort()).toStrictEqual(["w0", "w1", "w2", "w3", "w4", "w5"]);
		expect(new Set(processed).size).toBe(processed.length);
		expect(placeCalls[0]! > 0 && placeCalls[1]! > 0).toBeTrue();
	});

	it("should distribute concurrency unevenly, the remainder going to earlier places", () => {
		expect.assertions(2);

		const runTaskA = vi.fn<() => Promise<ScriptResult>>(async () => makeDeferred().promise);
		const runTaskB = vi.fn<() => Promise<ScriptResult>>(async () => makeDeferred().promise);

		// 5 slots across 2 places ⇒ ⌊5/2⌋ = 2 each, remainder 1 to the first.
		void runTaskPool({
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

		void runTaskPool({
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

		void runTaskPool({
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

		let attempt = 0;
		const runTask = vi.fn<() => Promise<ScriptResult>>(async () => {
			attempt += 1;
			if (attempt === 1) {
				throw new RateLimitError("slow down", { retryAfterSeconds: 7 });
			}

			return makeScriptResult();
		});
		const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue();
		const onError = vi.fn<(error: unknown) => void>();

		await runTaskPool({
			concurrency: 1,
			isDone: () => attempt >= 2,
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

		let attempt = 0;
		const runTask = vi.fn<() => Promise<ScriptResult>>(async () => {
			attempt += 1;
			if (attempt === 1) {
				// A 429 with retry-after 0 must not yield a sleep(0) tight loop.
				throw new RateLimitError("slow down", { retryAfterSeconds: 0 });
			}

			return makeScriptResult();
		});
		const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue();

		await runTaskPool({
			concurrency: 1,
			isDone: () => attempt >= 2,
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

		let attempt = 0;
		const runTask = vi.fn<() => Promise<ScriptResult>>(async () => {
			attempt += 1;
			if (attempt === 1) {
				throw new ApiError("full", { code: "RESOURCE_EXHAUSTED", statusCode: 429 });
			}

			return makeScriptResult();
		});
		const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue();

		await runTaskPool({
			concurrency: 1,
			isDone: () => attempt >= 2,
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

		let attempt = 0;
		const clock = { ms: 0 };
		const runTask = vi.fn<() => Promise<ScriptResult>>(async () => {
			attempt += 1;
			if (attempt === 2) {
				// 2s after the first task completed (at clock 0): inside the ~10s
				// recycle window, so the long server retry-after must NOT win.
				clock.ms = 2000;
				throw new RateLimitError("slow down", { retryAfterSeconds: 30 });
			}

			return makeScriptResult();
		});
		const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue();

		await runTaskPool({
			concurrency: 1,
			isDone: () => attempt >= 3,
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

		let attempt = 0;
		const runTask = vi.fn<() => Promise<ScriptResult>>(async () => {
			attempt += 1;
			if (attempt === 1) {
				throw new Error("execute failed", {
					cause: new RateLimitError("slow down", { retryAfterSeconds: 3 }),
				});
			}

			return makeScriptResult();
		});
		const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue();

		await runTaskPool({
			concurrency: 1,
			isDone: () => attempt >= 2,
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

		let attempt = 0;
		const apiError = new ApiError("not found", { code: "NotFound", statusCode: 404 });
		const runTask = vi.fn<() => Promise<ScriptResult>>(async () => {
			attempt += 1;
			if (attempt === 1) {
				throw apiError;
			}

			return makeScriptResult();
		});
		const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue();
		const onError = vi.fn<(error: unknown) => void>();

		await runTaskPool({
			concurrency: 1,
			isDone: () => attempt >= 2,
			onError,
			onResult: () => {},
			places: [{ runTask }],
			sleep,
		});

		expect(runTask).toHaveBeenCalledTimes(2);
		expect(onError).toHaveBeenCalledExactlyOnceWith(apiError);
		expect(sleep).not.toHaveBeenCalled();
	});
});
