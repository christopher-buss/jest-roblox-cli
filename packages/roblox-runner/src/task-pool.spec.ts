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
			runTask,
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
			runTask,
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
			runTask,
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
			runTask,
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
			runTask,
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
				runTask,
			}),
		).resolves.toBeUndefined();
	});

	it("should reject a non-positive concurrency", async () => {
		expect.assertions(1);

		const runTask = vi.fn<() => Promise<ScriptResult>>(async () => makeScriptResult());

		await expect(
			runTaskPool({ concurrency: 0, isDone: () => false, onResult: () => {}, runTask }),
		).rejects.toThrow(/concurrency must be >= 1/);
	});

	it("should launch nothing when work is already done at start", async () => {
		expect.assertions(1);

		const runTask = vi.fn<() => Promise<ScriptResult>>(async () => makeScriptResult());
		await runTaskPool({
			concurrency: 4,
			isDone: () => true,
			onResult: () => {},
			runTask,
		});

		expect(runTask).not.toHaveBeenCalled();
	});
});
