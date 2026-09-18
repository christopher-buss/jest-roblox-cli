import { ApiError, NetworkError, PollTimeoutError } from "@bedrock-rbx/ocale";
import { StorageClient } from "@bedrock-rbx/ocale/storage";
import {
	ExecutionTimeoutError,
	type ScriptResult,
	TaskSubmitError,
} from "@isentinel/roblox-runner";

import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { setTimeout as delayAsync, setImmediate as nextTurn } from "node:timers/promises";
import { zstdCompressSync } from "node:zlib";
import { assert, describe, expect, it, vi } from "vitest";

import { EXECUTION_NOT_CLAIMED } from "../luau/execution-claim.ts";
import { executeWithRecoveryAsync, type ExecutionAttemptContext } from "./execution-recovery.ts";
import { executeWithResultRelayAsync, type ResultRelayOptions } from "./result-relay.ts";
import { UncertainSubmissionError } from "./uncertain-submission.ts";

type Get = StorageClient["sortedMaps"]["get"];
type Delete = StorageClient["sortedMaps"]["delete"];

interface RelayChunk extends Record<string, JSONValue> {
	attempt: string;
	chunkCount: number;
	data: string;
	sequence: number;
	uncompressedLength: number;
	version: number;
}

function storage(get: Get, remove: Delete): StorageClient {
	const value: StorageClient = Object.create(StorageClient.prototype);
	Object.defineProperty(value, "sortedMaps", { value: { delete: remove, get } });
	return value;
}

function relayStorage(
	outputs: Array<string> | { error: string },
	mutate?: (value: RelayChunk) => void,
) {
	const encoded = zstdCompressSync(Buffer.from(JSON.stringify(outputs))).toString("base64");
	const chunks = encoded.match(/.{1,3500}/gu)!;
	const get = vi.fn<Get>(async ({ itemId }) => {
		const [attempt, sequenceRaw] = itemId.split(":", 2);
		const sequence = Number(sequenceRaw);
		const value: RelayChunk = {
			attempt: attempt!,
			chunkCount: chunks.length,
			data: chunks[sequence - 1]!,
			sequence,
			uncompressedLength: Buffer.byteLength(JSON.stringify(outputs)),
			version: 1,
		};
		mutate?.(value);
		return {
			data: {
				id: itemId,
				etag: "e",
				expiresAt: new Date(),
				mapId: "map",
				sortKey: undefined,
				universeId: "u",
				value,
			},
			success: true,
		};
	});
	const remove = vi.fn<Delete>(async () => ({ data: undefined, success: true }));
	return { chunkCount: chunks.length, get, remove, value: storage(get, remove) };
}

function withMissingSecondChunk(readChunk: Get): Get {
	return async (parameters, options) => {
		if (parameters.itemId.endsWith(":2")) {
			return { err: new ApiError("missing", { statusCode: 404 }), success: false };
		}

		return readChunk(parameters, options);
	};
}

async function nativeAfterRelayAsync() {
	// Immediate fake storage calls and decoding settle before the native result.
	await nextTurn();

	return { durationMs: 1, outputs: ["native"] };
}

function changingMetadata(field: "chunkCount" | "uncompressedLength") {
	return (value: RelayChunk): void => {
		value.chunkCount = 2;
		value.data = "";
		value[field] += value.sequence - 1;
	};
}

const credentials = { apiKey: "key", universeId: "universe" };

describe("ambiguous submissions", () => {
	it("should give a delayed accepted relay the remaining observation time", async () => {
		expect.assertions(1);

		const relay = relayStorage(["delayed full result"]);
		const publish = Promise.withResolvers<void>();
		async function getAsync(
			parameters: Parameters<Get>[0],
			options: Parameters<Get>[1],
		): ReturnType<Get> {
			await publish.promise;
			return relay.get(parameters, options);
		}

		const outcome: unknown = await executeWithResultRelayAsync({
			credentials,
			executeAsync: async () => {
				throw new TaskSubmitError(new ApiError("failed", { statusCode: 500 }));
			},
			script: "return 'x'",
			storageFactory: () => storage(getAsync, relay.remove),
			timeout: 1000,
		}).catch((err: unknown) => err);
		assert.instanceOf(outcome, UncertainSubmissionError);
		const reading = outcome.readResultAsync().catch((err: unknown) => err);
		await delayAsync(10);
		publish.resolve();

		await expect(reading).resolves.toMatchObject({ outputs: ["delayed full result"] });
	});

	it(
		"should not restart the uncertainty deadline when recovery reads begin",
		{ timeout: 500 },
		async () => {
			expect.assertions(1);

			let now = 1000;
			const failure = new TaskSubmitError(
				new ApiError("create unanswered", { statusCode: 500 }),
			);
			const outcome: unknown = await executeWithResultRelayAsync({
				credentials,
				executeAsync: async () => {
					throw failure;
				},
				now: () => now,
				script: "return 'x'",
				storageFactory: () => {
					return storage(
						vi.fn<Get>(async () => new Promise(() => {})),
						vi.fn<Delete>(),
					);
				},
				timeout: 5000,
			}).catch((err: unknown) => err);
			assert.instanceOf(outcome, UncertainSubmissionError);
			now = 6000;

			await expect(outcome.readResultAsync()).rejects.toBe(failure);
		},
	);

	it.for([
		new TaskSubmitError(new ApiError("POST failed", { statusCode: 500 })),
		new TaskSubmitError(
			new NetworkError("POST timed out", {
				cause: new DOMException("deadline", "TimeoutError"),
			}),
		),
	])("should retain the first relay when a fresh submission loses the claim", async (failure) => {
		expect.assertions(5);

		const relay = relayStorage(["full original results", "coverage"]);
		const publish = Promise.withResolvers<void>();
		async function getAsync(
			parameters: Parameters<Get>[0],
			options: Parameters<Get>[1],
		): ReturnType<Get> {
			await publish.promise;
			return relay.get(parameters, options);
		}

		const submit = vi
			.fn<ResultRelayOptions["executeAsync"]>()
			.mockRejectedValueOnce(failure)
			.mockImplementationOnce(async () => {
				publish.resolve();
				return { durationMs: 1, outputs: [EXECUTION_NOT_CLAIMED] };
			});
		const result = await executeWithRecoveryAsync({
			executeAsync: async ({ claim, observationSignal }) => {
				return executeWithResultRelayAsync({
					credentials,
					executeAsync: submit,
					script: claim,
					signal: observationSignal,
					storageFactory: () => storage(getAsync, relay.remove),
					timeout: 1000,
				});
			},
			timeout: 1000,
		});

		expect(result.outputs).toStrictEqual(["full original results", "coverage"]);
		expect(submit).toHaveBeenCalledTimes(2);
		expect(submit.mock.calls[0]![0].split("\n", 1)[0]).not.toBe(
			submit.mock.calls[1]![0].split("\n", 1)[0],
		);
		expect(submit.mock.calls[0]![0].split("local function original", 2)[1]).toBe(
			submit.mock.calls[1]![0].split("local function original", 2)[1],
		);
		expect(submit.mock.calls.map(([, signal]) => signal.aborted)).toStrictEqual([true, true]);
	});

	it("should surface a relayed runtime failure instead of waiting for native completion", async () => {
		expect.assertions(1);

		const relay = relayStorage({ error: "test script exploded\nstacktrace" });

		await expect(
			executeWithResultRelayAsync({
				credentials,
				executeAsync: nativeAfterRelayAsync,
				script: "error('test script exploded')",
				storageFactory: () => relay.value,
				timeout: 1000,
			}),
		).rejects.toThrow("test script exploded\nstacktrace");
	});

	it("should keep the ambiguous create bounded when its relay never answers", async () => {
		expect.assertions(2);

		const failure = new TaskSubmitError(new ApiError("POST failed", { statusCode: 500 }));
		const get = vi.fn<Get>(async () => new Promise(() => {}));
		const outcome: unknown = await executeWithResultRelayAsync({
			credentials,
			executeAsync: async () => {
				throw failure;
			},
			script: "return 'x'",
			storageFactory: () => storage(get, vi.fn<Delete>()),
			timeout: 10,
		}).catch((err: unknown) => err);
		assert.instanceOf(outcome, UncertainSubmissionError);

		await expect(outcome.readResultAsync()).rejects.toBe(failure);
		expect(get.mock.calls[0]![1]!.signal!.aborted).toBeTrue();
	});

	it("should stop an uncertain reader when its owner cancels", async () => {
		expect.assertions(2);

		const get = vi.fn<Get>(async () => new Promise(() => {}));
		const outcome: unknown = await executeWithResultRelayAsync({
			credentials,
			executeAsync: async () => {
				throw new TaskSubmitError(new ApiError("POST failed", { statusCode: 500 }));
			},
			script: "return 'x'",
			storageFactory: () => storage(get, vi.fn<Delete>()),
			timeout: 60_000,
		}).catch((err: unknown) => err);
		assert.instanceOf(outcome, UncertainSubmissionError);
		const owner = new AbortController();
		const reading = outcome.readResultAsync(owner.signal);
		owner.abort();

		await expect(reading).rejects.toThrow("aborted");
		expect(get.mock.calls[0]![1]!.signal!.aborted).toBeTrue();
	});

	it.for([
		{
			expected: { message: "uncertain create" },
			storageFactory: (): StorageClient => {
				throw new Error("relay unavailable");
			},
		},
		{
			expected: { message: "runtime failure" },
			storageFactory: () => relayStorage({ error: "runtime failure" }).value,
		},
		{ expected: { outputs: ["saved"] }, storageFactory: () => relayStorage(["saved"]).value },
	])("should consume an uncertain relay outcome", async ({ expected, storageFactory }) => {
		expect.assertions(1);

		const failure = new TaskSubmitError(new ApiError("uncertain create", { statusCode: 502 }));
		const error: unknown = await executeWithResultRelayAsync({
			credentials,
			executeAsync: async () => {
				throw failure;
			},
			script: "return 'x'",
			storageFactory,
			timeout: 1000,
		}).catch((err: unknown) => err);
		assert.instanceOf(error, UncertainSubmissionError);

		await expect(error.readResultAsync().catch((err: unknown) => err)).resolves.toMatchObject(
			expected,
		);
	});

	it("should not retain an ambiguous create after its owner already canceled", async () => {
		expect.assertions(1);

		const owner = new AbortController();
		owner.abort();
		const failure = new TaskSubmitError(new ApiError("create failed", { statusCode: 500 }));

		await expect(
			executeWithResultRelayAsync({
				credentials,
				executeAsync: async () => {
					throw failure;
				},
				script: "return 'x'",
				signal: owner.signal,
				storageFactory: () => {
					throw new Error("unavailable");
				},
				timeout: 1000,
			}),
		).rejects.toBe(failure);
	});

	it("should not start uncertain observation with an already canceled read signal", async () => {
		expect.assertions(1);

		const outcome: unknown = await executeWithResultRelayAsync({
			credentials,
			executeAsync: async () => {
				throw new TaskSubmitError(new ApiError("failed", { statusCode: 500 }));
			},
			script: "return 'x'",
			storageFactory: () => relayStorage(["saved"]).value,
			timeout: 1000,
		}).catch((err: unknown) => err);
		assert.instanceOf(outcome, UncertainSubmissionError);
		const owner = new AbortController();
		owner.abort(new Error("reader canceled"));

		await expect(outcome.readResultAsync(owner.signal)).rejects.toThrow("reader canceled");
	});
});

function recoveringRelay(relayAttempt: "original" | "replacement" = "original") {
	const clock = { now: 0 };
	const outputs = [randomBytes(12_000).toString("base64"), "coverage"];
	const relay = relayStorage(outputs);
	const published = Promise.withResolvers<void>();
	const firstAcknowledged = Promise.withResolvers<void>();
	const fullyAcknowledged = Promise.withResolvers<void>();
	const hedgeStarted = Promise.withResolvers<void>();
	const original = Promise.withResolvers<ScriptResult>();
	const hedge = Promise.withResolvers<ScriptResult>();
	const nativeReread = Promise.withResolvers<ScriptResult>();
	const rereadStarted = Promise.withResolvers<void>();
	const readResultAsync = vi.fn<(signal?: AbortSignal) => Promise<ScriptResult>>(async () => {
		rereadStarted.resolve();
		return nativeReread.promise;
	});
	const get = vi.fn<Get>(async (parameters, options) => {
		if (!parameters.itemId.endsWith(":1")) {
			await Promise.race([
				published.promise,
				delayAsync(60_000, undefined, { signal: options?.signal }),
			]);
		}

		return relay.get(parameters, options);
	});
	const remove = vi.fn<Delete>(async (parameters, options) => {
		const result = await relay.remove(parameters, options);
		firstAcknowledged.resolve();
		if (remove.mock.calls.length === relay.chunkCount) {
			fullyAcknowledged.resolve();
		}

		return result;
	});
	const submit = vi.fn<ResultRelayOptions["executeAsync"]>(async () => {
		return relayAttempt === "original" ? original.promise : hedge.promise;
	});
	const executeAsync = vi.fn<(context: ExecutionAttemptContext) => Promise<ScriptResult>>(
		async (context): Promise<ScriptResult> => {
			context.submission.accepted();
			const attempt = executeAsync.mock.calls.length > 1 ? "replacement" : "original";
			if (attempt === "replacement") {
				hedgeStarted.resolve();
			}

			if (attempt !== relayAttempt) {
				return attempt === "original" ? original.promise : hedge.promise;
			}

			return executeWithResultRelayAsync({
				credentials,
				executeAsync: submit,
				now: () => clock.now,
				script: "return 'complete result'",
				signal: context.observationSignal,
				storageFactory: () => storage(get, remove),
				timeout: 20_000,
			});
		},
	);
	const execution = executeWithRecoveryAsync({
		bootWatchMs: 0,
		executeAsync,
		readClaimAsync: async () => ({ status: "missing" }),
		timeout: 20_000,
		watchesSubmission: true,
	});
	const outcome = execution.catch((err: unknown) => err);
	const timeout = new ExecutionTimeoutError(
		new Error("native poll expired", {
			cause: new PollTimeoutError("pending", { timeoutMs: 1 }),
		}),
		readResultAsync,
	);
	return {
		clock,
		executeAsync,
		firstAcknowledged,
		fullyAcknowledged,
		get,
		hedge,
		hedgeStarted,
		nativeReread,
		original,
		outcome,
		outputs,
		published,
		readResultAsync,
		remove,
		rereadStarted,
		submit,
		timeout,
	};
}

describe(executeWithResultRelayAsync, () => {
	it("should reject an already canceled recovery without starting native polling", async () => {
		expect.assertions(2);

		const readResultAsync = vi.fn<(signal?: AbortSignal) => Promise<ScriptResult>>();
		const result = await executeWithResultRelayAsync({
			credentials,
			executeAsync: async () => {
				throw new ExecutionTimeoutError(new Error("expired"), readResultAsync);
			},
			script: "return 'x'",
			storageFactory: () => {
				throw new Error("unavailable");
			},
			timeout: 1000,
		}).catch((err: unknown) => err);
		assert.instanceOf(result, ExecutionTimeoutError);
		const recovery = new AbortController();
		const reason = new Error("other attempt won");
		recovery.abort(reason);

		await expect(result.readResultAsync(recovery.signal)).rejects.toBe(reason);
		expect(readResultAsync).not.toHaveBeenCalled();
	});

	it.for(["owner", "recovery"] as const)(
		"should cancel native rereading when its %s signal aborts",
		async (source) => {
			expect.assertions(2);

			const owner = new AbortController();
			const recovery = new AbortController();
			const started = Promise.withResolvers<void>();
			const readResultAsync = vi.fn<(signal?: AbortSignal) => Promise<ScriptResult>>(
				async (signal) => {
					started.resolve();
					await delayAsync(60_000, undefined, { signal });
					return { durationMs: 1, outputs: ["native"] };
				},
			);
			const result = await executeWithResultRelayAsync({
				credentials,
				executeAsync: async () => {
					throw new ExecutionTimeoutError(new Error("expired"), readResultAsync);
				},
				script: "return 'x'",
				signal: owner.signal,
				storageFactory: () => {
					throw new Error("unavailable");
				},
				timeout: 1000,
			}).catch((err: unknown) => err);
			assert.instanceOf(result, ExecutionTimeoutError);
			const reading = result.readResultAsync(recovery.signal).catch((err: unknown) => err);
			await started.promise;
			const reason = new Error("observation canceled");
			({ owner, recovery })[source].abort(reason);

			await expect(reading).resolves.toHaveProperty("cause", reason);
			expect(readResultAsync.mock.calls[0]![0]!.aborted).toBeTrue();
		},
	);

	it("should recover the replacement relay when both native observers time out", async () => {
		expect.assertions(4);

		const run = recoveringRelay("replacement");
		await run.firstAcknowledged.promise;
		const originalReader = vi
			.fn<() => Promise<ScriptResult>>()
			.mockResolvedValue({ durationMs: 1, outputs: [EXECUTION_NOT_CLAIMED] });
		run.original.reject(
			new ExecutionTimeoutError(new Error("original expired"), originalReader),
		);
		run.hedge.reject(run.timeout);
		await run.rereadStarted.promise;
		run.published.resolve();

		await expect(run.outcome).resolves.toMatchObject({ outputs: run.outputs });
		expect(originalReader).toHaveBeenCalledOnce();
		expect(run.submit).toHaveBeenCalledOnce();
		expect(
			run.executeAsync.mock.calls.map(([context]) => context.observationSignal.aborted),
		).toStrictEqual([true, true]);
	});

	it("should resume an interrupted acknowledgement without fetching its chunk again", async () => {
		expect.assertions(4);

		const relay = relayStorage(["complete"]);
		const acknowledging = Promise.withResolvers<void>();
		const native = Promise.withResolvers<ScriptResult>();
		const readResultAsync = vi.fn<() => Promise<ScriptResult>>(
			async () => new Promise<never>(() => {}),
		);
		relay.remove
			.mockImplementationOnce(async (_parameters, options) => {
				acknowledging.resolve();
				await delayAsync(60_000, undefined, { signal: options!.signal });
				return { data: undefined, success: true };
			})
			.mockResolvedValueOnce({
				err: new ApiError("already removed", { statusCode: 404 }),
				success: false,
			});
		const result = executeWithResultRelayAsync({
			credentials,
			executeAsync: async () => native.promise,
			script: "return 'complete'",
			storageFactory: () => relay.value,
			timeout: 1000,
		}).catch((err: unknown) => err);
		await acknowledging.promise;
		native.reject(new ExecutionTimeoutError(new Error("poll expired"), readResultAsync));
		const timeout = await result;
		assert.instanceOf(timeout, ExecutionTimeoutError);

		await expect(timeout.readResultAsync()).resolves.toMatchObject({ outputs: ["complete"] });
		expect(relay.get).toHaveBeenCalledOnce();
		expect(relay.remove).toHaveBeenCalledTimes(2);
		expect(relay.remove.mock.calls[1]![1]!.signal!.aborted).toBeTrue();
	});

	it("should bound a retained relay when its recovery callback is never used", async () => {
		expect.assertions(3);

		const started = Promise.withResolvers<AbortSignal>();
		const resumed = Promise.withResolvers<AbortSignal>();
		const reads = [started, resumed];
		const native = Promise.withResolvers<ScriptResult>();
		const get = vi.fn<Get>(async (_parameters, options) => {
			const signal = options!.signal!;
			reads.shift()!.resolve(signal);
			await delayAsync(60_000, undefined, { signal });
			return { err: new ApiError("no result", { statusCode: 404 }), success: false };
		});
		const result = executeWithResultRelayAsync({
			credentials,
			executeAsync: async () => native.promise,
			script: "return 'x'",
			storageFactory: () => storage(get, async () => ({ data: undefined, success: true })),
			timeout: 30,
		}).catch((err: unknown) => err);
		await started.promise;
		native.reject(
			new ExecutionTimeoutError(new Error("poll expired"), async () => {
				return {
					durationMs: 1,
					outputs: [],
				};
			}),
		);

		await expect(result).resolves.toBeInstanceOf(ExecutionTimeoutError);

		const signal = await resumed.promise;

		expect(signal.aborted).toBeFalse();

		await delayAsync(60);

		expect(signal.aborted).toBeTrue();
	});

	it("should retain acknowledged chunks and drain the original while a refused hedge is pending", async () => {
		expect.assertions(5);

		const run = recoveringRelay();
		await Promise.all([run.firstAcknowledged.promise, run.hedgeStarted.promise]);
		run.original.reject(run.timeout);
		await nextTurn();
		run.clock.now = 1000;
		run.published.resolve();
		await run.fullyAcknowledged.promise;
		run.clock.now = 7000;
		await nextTurn();

		expect(run.readResultAsync).not.toHaveBeenCalled();

		run.nativeReread.resolve({ durationMs: 1, outputs: ["truncated native output"] });
		run.hedge.resolve({ durationMs: 1, outputs: [EXECUTION_NOT_CLAIMED] });

		await expect(run.outcome).resolves.toMatchObject({ outputs: run.outputs });
		expect(
			run.remove.mock.calls.filter(([parameters]) => parameters.itemId.endsWith(":1")),
		).toHaveLength(1);
		expect(run.submit).toHaveBeenCalledOnce();
		expect(
			run.executeAsync.mock.calls.map(([context]) => context.observationSignal.aborted),
		).toStrictEqual([true, true]);
	});

	it("should receive the original relay after native recovery starts", async () => {
		expect.assertions(4);

		const run = recoveringRelay();
		const stopped = Promise.withResolvers<void>();
		run.readResultAsync.mockImplementationOnce(async (signal) => {
			run.rereadStarted.resolve();
			try {
				await delayAsync(60_000, undefined, { signal });
				return { durationMs: 1, outputs: ["native"] };
			} finally {
				stopped.resolve();
			}
		});
		await Promise.all([run.firstAcknowledged.promise, run.hedgeStarted.promise]);
		run.original.reject(run.timeout);
		run.hedge.resolve({ durationMs: 1, outputs: [EXECUTION_NOT_CLAIMED] });
		await run.rereadStarted.promise;
		run.published.resolve();

		await expect(run.outcome).resolves.toMatchObject({ outputs: run.outputs });

		await stopped.promise;

		expect(run.readResultAsync.mock.calls[0]![0]!.aborted).toBeTrue();
		expect(run.readResultAsync).toHaveBeenCalledOnce();
		expect(run.submit).toHaveBeenCalledOnce();
	});

	it("should resume buffered relay chunks when the hedge outlasts the retained reader", async () => {
		expect.assertions(4);

		const run = recoveringRelay();
		await Promise.all([run.firstAcknowledged.promise, run.hedgeStarted.promise]);
		run.original.reject(run.timeout);
		await nextTurn();
		run.clock.now = 30_000;
		run.published.resolve();
		await nextTurn();

		expect(run.remove).toHaveBeenCalledTimes(2);

		run.hedge.resolve({ durationMs: 1, outputs: [EXECUTION_NOT_CLAIMED] });

		await expect(run.outcome).resolves.toMatchObject({ outputs: run.outputs });
		expect(run.submit).toHaveBeenCalledOnce();
		expect(
			run.remove.mock.calls.filter(([parameters]) => parameters.itemId.endsWith(":1")),
		).toHaveLength(1);
	});

	it("should cancel a retained relay when the hedge wins without rereading native output", async () => {
		expect.assertions(3);

		const run = recoveringRelay();
		await Promise.all([run.firstAcknowledged.promise, run.hedgeStarted.promise]);
		run.original.reject(run.timeout);
		await nextTurn();
		run.hedge.resolve({ durationMs: 1, outputs: ["hedge result"] });

		await expect(run.outcome).resolves.toMatchObject({ outputs: ["hedge result"] });
		expect(run.readResultAsync).not.toHaveBeenCalled();
		expect(run.get.mock.calls.at(-1)![1]!.signal!.aborted).toBeTrue();
	});

	it("should cancel the retained relay after native recovery fails", async () => {
		expect.assertions(3);

		const run = recoveringRelay();
		await Promise.all([run.firstAcknowledged.promise, run.hedgeStarted.promise]);
		run.original.reject(run.timeout);
		run.hedge.reject(new Error("replacement failed"));
		await run.rereadStarted.promise;
		run.nativeReread.reject(new Error("native recovery expired"));

		await expect(run.outcome).resolves.toBeInstanceOf(AggregateError);
		expect(
			run.executeAsync.mock.calls.map(([context]) => context.observationSignal.aborted),
		).toStrictEqual([true, true]);
		expect(run.get.mock.calls.at(-1)![1]!.signal!.aborted).toBeTrue();
	});

	it("should preserve leading directives and pass the runtime budget", async () => {
		expect.assertions(3);

		let wrapped = "";
		await executeWithResultRelayAsync({
			credentials,
			executeAsync: async (script) => {
				wrapped = script;
				return { durationMs: 1, outputs: ["native"] };
			},
			runtimeBudget: 30_000,
			script: "--!strict\n-- comment\n--!optimize 2\nlocal value = 'x'\nreturn value",
			storageFactory: () => {
				throw new Error("unavailable");
			},
			timeout: 1000,
		});

		expect(wrapped).toStartWith("--!strict\n-- comment\n--!optimize 2\nlocal attempt");
		expect(wrapped).toContain("local publishBudgetSeconds = 30");
		expect(wrapped).toContain("local function original(...)\nlocal value = 'x'\nreturn value");
	});

	it.for([
		{ expected: "local publishBudgetSeconds = 300", runtimeBudget: 600_000 },
		{ expected: "local publishBudgetSeconds = 0", runtimeBudget: 999 },
	])(
		"should clamp the runtime budget inserted into the wrapper",
		async ({ expected, runtimeBudget }) => {
			expect.assertions(2);

			let wrapped = "";
			await executeWithResultRelayAsync({
				credentials,
				executeAsync: async (script) => {
					wrapped = script;
					return { durationMs: 1, outputs: ["native"] };
				},
				runtimeBudget,
				script: "return 'x'",
				storageFactory: () => {
					throw new Error("unavailable");
				},
				timeout: 1000,
			});

			expect(wrapped).toContain(expected);
			expect(wrapped).toStartWith("local attempt");
		},
	);

	it("should return and drain a multi-chunk relayed result", async () => {
		expect.assertions(4);

		const outputs = [randomBytes(40_000).toString("base64"), "coverage"];
		const relay = relayStorage(outputs);
		let nativeSignal: AbortSignal | undefined;
		const executeAsync = vi.fn<ResultRelayOptions["executeAsync"]>(async (_script, signal) => {
			nativeSignal = signal;
			return new Promise<never>(() => {
				/* relay wins */
			});
		});

		await expect(
			executeWithResultRelayAsync({
				credentials,
				executeAsync,
				script: "return 'x'",
				storageFactory: () => relay.value,
				timeout: 1000,
			}),
		).resolves.toMatchObject({ outputs });
		expect(relay.get.mock.calls.length).toBeGreaterThan(1);
		expect(relay.remove).toHaveBeenCalledTimes(relay.get.mock.calls.length);
		expect(nativeSignal!.aborted).toBeTrue();
	});

	it("should prefer the native result and cancel relay observation", async () => {
		expect.assertions(2);

		let relaySignal: AbortSignal | undefined;
		const get = vi.fn<Get>(async (_parameters, options) => {
			relaySignal = options!.signal;
			return new Promise<never>(() => {
				/* native wins */
			});
		});
		const remove = vi.fn<Delete>();

		await expect(
			executeWithResultRelayAsync({
				credentials,
				executeAsync: async () => ({ durationMs: 1, outputs: ["native"] }),
				script: "return 'x'",
				storageFactory: () => storage(get, remove),
				timeout: 1000,
			}),
		).resolves.toMatchObject({ outputs: ["native"] });
		expect(relaySignal!.aborted).toBeTrue();
	});

	it("should report elapsed relay time from the supplied clock", async () => {
		expect.assertions(1);

		let clock = 100;
		const relay = relayStorage(["relay"]);
		relay.remove.mockImplementation(async () => {
			clock = 137;
			return { data: undefined, success: true };
		});

		await expect(
			executeWithResultRelayAsync({
				credentials,
				executeAsync: nativeAfterRelayAsync,
				now: () => clock,
				script: "return 'x'",
				storageFactory: () => relay.value,
				timeout: 1000,
			}),
		).resolves.toStrictEqual({ durationMs: 37, outputs: ["relay"] });
	});

	it("should poll faster while draining chunks than while waiting for the first", async () => {
		expect.assertions(2);

		const outputs = [randomBytes(5000).toString("base64")];
		const relay = relayStorage(outputs);
		const readChunk = relay.get.getMockImplementation()!;
		const missing = {
			err: new ApiError("missing", { statusCode: 404 }),
			success: false,
		} satisfies Awaited<ReturnType<Get>>;
		relay.get
			.mockResolvedValueOnce(missing)
			.mockImplementationOnce(readChunk)
			.mockResolvedValueOnce(missing);
		const waitAsync = vi.fn<NonNullable<ResultRelayOptions["waitAsync"]>>(async () => {});

		await expect(
			executeWithResultRelayAsync({
				credentials,
				executeAsync: nativeAfterRelayAsync,
				script: "return 'x'",
				storageFactory: () => relay.value,
				timeout: 1000,
				waitAsync,
			}),
		).resolves.toMatchObject({ outputs });
		expect(waitAsync.mock.calls.map(([ms]) => ms)).toStrictEqual([1000, 100]);
	});

	it("should fall back to a native result when relay access is unavailable", async () => {
		expect.assertions(2);

		const get = vi.fn<Get>(async () => {
			return { err: new ApiError("forbidden", { statusCode: 403 }), success: false };
		});
		const remove = vi.fn<Delete>();
		const waitAsync = vi.fn<NonNullable<ResultRelayOptions["waitAsync"]>>();

		await expect(
			executeWithResultRelayAsync({
				credentials,
				executeAsync: nativeAfterRelayAsync,
				script: "return 'x'",
				storageFactory: () => storage(get, remove),
				timeout: 1000,
				waitAsync,
			}),
		).resolves.toMatchObject({ outputs: ["native"] });
		expect(waitAsync).not.toHaveBeenCalled();
	});

	it.for<Partial<RelayChunk>>([
		{ attempt: "another-attempt" },
		{ sequence: 2 },
		{ version: 2 },
		{ chunkCount: 0 },
		{ chunkCount: 1.5 },
		{ chunkCount: 4097 },
		{ data: "x".repeat(3501) },
		{ uncompressedLength: -1 },
		{ uncompressedLength: 1.5 },
		{ uncompressedLength: 64 * 1024 * 1024 + 1 },
	])("should reject malformed relay metadata %j before acknowledging it", async (invalid) => {
		expect.assertions(3);

		const relay = relayStorage(["relay"], (value) => {
			Object.assign(value, invalid);
		});

		await expect(
			executeWithResultRelayAsync({
				credentials,
				executeAsync: nativeAfterRelayAsync,
				script: "return 'x'",
				storageFactory: () => relay.value,
				timeout: 1000,
			}),
		).resolves.toMatchObject({ outputs: ["native"] });
		expect(relay.get).toHaveBeenCalledOnce();
		expect(relay.remove).not.toHaveBeenCalled();
	});

	it("should clean up relay observation when native execution rejects", async () => {
		expect.assertions(2);

		let relaySignal: AbortSignal | undefined;
		const get = vi.fn<Get>(async (_parameters, options) => {
			relaySignal = options!.signal;
			return new Promise<never>(() => {
				/* native rejects */
			});
		});
		const failure = new Error("native failed");

		await expect(
			executeWithResultRelayAsync({
				credentials,
				executeAsync: async () => {
					throw failure;
				},
				script: "return 'x'",
				storageFactory: () => storage(get, vi.fn<Delete>()),
				timeout: 1000,
			}),
		).rejects.toBe(failure);
		expect(relaySignal!.aborted).toBeTrue();
	});

	it("should cancel native execution and an in-flight chunk acknowledgement together", async () => {
		expect.assertions(2);

		const caller = new AbortController();
		const acknowledging = Promise.withResolvers<AbortSignal>();
		const relay = relayStorage(["relay"]);
		relay.remove.mockImplementation(async (_parameters, options) => {
			assert(options);
			assert(options.signal);
			acknowledging.resolve(options.signal);
			await delayAsync(60_000, undefined, { signal: options.signal });
			return { data: undefined, success: true };
		});
		const execution = executeWithResultRelayAsync({
			credentials,
			executeAsync: async (_script, signal) => {
				await delayAsync(60_000, undefined, { signal });
				return { durationMs: 1, outputs: ["native"] };
			},
			script: "return 'x'",
			signal: caller.signal,
			storageFactory: () => relay.value,
			timeout: 1000,
		});
		const outcome = execution.catch((err: unknown) => err);
		const acknowledgementSignal = await acknowledging.promise;
		caller.abort("caller stopped");

		await expect(outcome).resolves.toHaveProperty("cause", "caller stopped");
		expect(acknowledgementSignal.aborted).toBeTrue();
	});

	it("should propagate an already-aborted caller signal", async () => {
		expect.assertions(2);

		const abort = new AbortController();
		abort.abort("caller stopped");
		let wasExecutionAborted = false;
		const failure = new Error("aborted");

		await expect(
			executeWithResultRelayAsync({
				credentials,
				executeAsync: async (_script, signal) => {
					wasExecutionAborted = signal.aborted;
					throw failure;
				},
				script: "return 'x'",
				signal: abort.signal,
				storageFactory: () => {
					throw new Error("unavailable");
				},
				timeout: 1000,
			}),
		).rejects.toBe(failure);
		expect(wasExecutionAborted).toBeTrue();
	});

	it("should not start a wait for an already-aborted relay observation", async () => {
		expect.assertions(1);

		const abort = new AbortController();
		abort.abort("caller stopped");
		const get = vi.fn<Get>(async () => {
			return { err: new ApiError("missing", { statusCode: 404 }), success: false };
		});
		const failure = new Error("aborted");

		await expect(
			executeWithResultRelayAsync({
				credentials,
				executeAsync: async () => {
					await Promise.resolve();
					await Promise.resolve();
					throw failure;
				},
				script: "return 'x'",
				signal: abort.signal,
				storageFactory: () => storage(get, vi.fn<Delete>()),
				timeout: 1000,
			}),
		).rejects.toBe(failure);
	});

	it("should tolerate an unavailable storage factory", async () => {
		expect.assertions(1);

		await expect(
			executeWithResultRelayAsync({
				credentials,
				executeAsync: async () => ({ durationMs: 1, outputs: ["native"] }),
				script: "return 'x'",
				storageFactory: () => {
					throw new Error("unavailable");
				},
				timeout: 1000,
			}),
		).resolves.toMatchObject({ outputs: ["native"] });
	});

	it("should abandon a missing relay chunk at its deadline", async () => {
		expect.assertions(2);

		const get = vi.fn<Get>(async () => {
			return { err: new ApiError("missing", { statusCode: 404 }), success: false };
		});
		let clock = 0;
		function now(): number {
			return clock;
		}

		await expect(
			executeWithResultRelayAsync({
				credentials,
				executeAsync: nativeAfterRelayAsync,
				now,
				script: "return 'x'",
				storageFactory: () => storage(get, vi.fn<Delete>()),
				timeout: 1,
				waitAsync: async () => {
					clock = 1;
				},
			}),
		).resolves.toMatchObject({ outputs: ["native"] });
		expect(get).toHaveBeenCalledOnce();
	});

	it("should fall back when deleting an acknowledged chunk fails", async () => {
		expect.assertions(2);

		const relay = relayStorage(["relay"]);
		relay.remove.mockResolvedValueOnce({
			err: new ApiError("delete failed", { statusCode: 500 }),
			success: false,
		});

		await expect(
			executeWithResultRelayAsync({
				credentials,
				executeAsync: nativeAfterRelayAsync,
				script: "return 'x'",
				storageFactory: () => relay.value,
				timeout: 1000,
			}),
		).resolves.toMatchObject({ outputs: ["native"] });
		expect(relay.remove).toHaveBeenCalledOnce();
	});

	it("should never return an incomplete relay when a later chunk is missing", async () => {
		expect.assertions(3);

		const relay = relayStorage(["relay"], (value) => {
			value.chunkCount = 2;
		});
		const readChunk = relay.get.getMockImplementation()!;
		relay.get.mockImplementation(withMissingSecondChunk(readChunk));

		await expect(
			executeWithResultRelayAsync({
				credentials,
				executeAsync: nativeAfterRelayAsync,
				script: "return 'x'",
				storageFactory: () => relay.value,
				timeout: 1000,
				waitAsync: async (_ms) => {
					throw new Error("stop polling");
				},
			}),
		).resolves.toMatchObject({ outputs: ["native"] });
		expect(relay.get).toHaveBeenCalledTimes(2);
		expect(relay.remove).toHaveBeenCalledOnce();
	});

	it("should poll again after the default wait settles", async () => {
		expect.assertions(3);

		const relay = relayStorage(["relay"]);
		relay.get.mockResolvedValueOnce({
			err: new ApiError("missing", { statusCode: 404 }),
			success: false,
		});
		const execution = executeWithResultRelayAsync({
			credentials,
			executeAsync: async () => {
				return new Promise<never>(() => {
					/* relay wins */
				});
			},
			now: () => 0,
			script: "return 'x'",
			storageFactory: () => relay.value,
			timeout: 2000,
		});
		const settled = vi.fn<(value: unknown) => void>();
		void execution.then(settled).catch(settled);
		await delayAsync(20);

		expect(settled).not.toHaveBeenCalled();

		await expect(execution).resolves.toMatchObject({ outputs: ["relay"] });
		expect(relay.get).toHaveBeenCalledTimes(2);
	});

	it("should cancel the default relay wait when native execution fails", async () => {
		expect.assertions(1);

		const get = vi.fn<Get>(async () => {
			return { err: new ApiError("missing", { statusCode: 404 }), success: false };
		});
		const failure = new Error("native failed");

		await expect(
			executeWithResultRelayAsync({
				credentials,
				executeAsync: async () => {
					await Promise.resolve();
					throw failure;
				},
				script: "return 'x'",
				storageFactory: () => storage(get, vi.fn<Delete>()),
				timeout: 2000,
			}),
		).rejects.toBe(failure);
	});

	it("should reject a decompressed payload whose declared length is wrong", async () => {
		expect.assertions(2);

		const relay = relayStorage(["relay"], (value) => {
			value.uncompressedLength += 1;
		});

		await expect(
			executeWithResultRelayAsync({
				credentials,
				executeAsync: nativeAfterRelayAsync,
				script: "return 'x'",
				storageFactory: () => relay.value,
				timeout: 1000,
			}),
		).resolves.toMatchObject({ outputs: ["native"] });
		expect(relay.remove).toHaveBeenCalledOnce();
	});

	it.for(["chunkCount", "uncompressedLength"] as const)(
		"should stop before acknowledging a changed %s in a later chunk",
		async (field) => {
			expect.assertions(3);

			const relay = relayStorage(["relay"], changingMetadata(field));

			await expect(
				executeWithResultRelayAsync({
					credentials,
					executeAsync: nativeAfterRelayAsync,
					script: "return 'x'",
					storageFactory: () => relay.value,
					timeout: 1000,
				}),
			).resolves.toMatchObject({ outputs: ["native"] });
			expect(relay.get).toHaveBeenCalledTimes(2);
			expect(relay.remove).toHaveBeenCalledOnce();
		},
	);

	it.for([
		{ label: "invalid JSON", payload: Buffer.from("not json") },
		{ label: "non-string output", payload: Buffer.from('["relay",1]') },
		{ label: "invalid UTF-8", payload: Buffer.from([0x5b, 0x22, 0xff, 0x22, 0x5d]) },
	])("should reject a complete relay containing $label", async ({ payload }) => {
		expect.assertions(2);

		const relay = relayStorage(["relay"], (value) => {
			value.data = zstdCompressSync(payload).toString("base64");
			value.uncompressedLength = payload.byteLength;
		});

		await expect(
			executeWithResultRelayAsync({
				credentials,
				executeAsync: nativeAfterRelayAsync,
				script: "return 'x'",
				storageFactory: () => relay.value,
				timeout: 1000,
			}),
		).resolves.toMatchObject({ outputs: ["native"] });
		expect(relay.remove).toHaveBeenCalledOnce();
	});
});
