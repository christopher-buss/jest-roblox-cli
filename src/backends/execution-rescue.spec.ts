import { ApiError } from "@bedrock-rbx/ocale";
import { StorageClient } from "@bedrock-rbx/ocale/storage";
import {
	ExecutionTimeoutError,
	readRefusedPlaceVersion,
	type ScriptResult,
	TaskSubmitError,
} from "@isentinel/roblox-runner";
import { formatPlaceMismatch } from "@isentinel/roblox-runner/testing";

import { Buffer } from "node:buffer";
import { zstdCompressSync } from "node:zlib";
import { assert, describe, expect, it, vi } from "vitest";

import { EXECUTION_NOT_CLAIMED } from "../luau/execution-claim.ts";
import { executeWithRecoveryAsync, type ExecutionAttemptContext } from "./execution-recovery.ts";
import { executeWithResultRelayAsync } from "./result-relay.ts";
import { withResultReader } from "./uncertain-submission.ts";

const credentials = { apiKey: "key", universeId: "universe" };
const denied = { durationMs: 1, outputs: [EXECUTION_NOT_CLAIMED] };
type ExecuteAttempt = (context: ExecutionAttemptContext) => Promise<ScriptResult>;

function createRelayStorage(
	payload: Array<string> | { error: string },
	available: Promise<void>,
): StorageClient {
	const json = JSON.stringify(payload);
	const data = zstdCompressSync(Buffer.from(json)).toString("base64");
	async function getAsync({
		itemId,
	}: Parameters<StorageClient["sortedMaps"]["get"]>[0]): ReturnType<
		StorageClient["sortedMaps"]["get"]
	> {
		await available;
		return {
			data: {
				id: itemId,
				etag: "etag",
				expiresAt: new Date(),
				mapId: "map",
				sortKey: undefined,
				universeId: credentials.universeId,
				value: {
					attempt: itemId.split(":", 1)[0]!,
					chunkCount: 1,
					data,
					sequence: 1,
					uncompressedLength: Buffer.byteLength(json),
					version: 1,
				},
			},
			success: true,
		};
	}

	async function removeAsync(): ReturnType<StorageClient["sortedMaps"]["delete"]> {
		return { data: undefined, success: true };
	}

	const storage: StorageClient = Object.create(StorageClient.prototype);
	Object.defineProperty(storage, "sortedMaps", { value: { delete: removeAsync, get: getAsync } });
	return storage;
}

function createFailedOriginal() {
	const publish = Promise.withResolvers<void>();
	const signals: Array<AbortSignal> = [];
	const executeAsync = vi.fn<ExecuteAttempt>(
		async ({ claim, observationSignal }: ExecutionAttemptContext) => {
			const isOriginal = signals.length === 0;
			return executeWithResultRelayAsync({
				credentials,
				executeAsync: async (_script, signal) => {
					signals.push(signal);
					if (isOriginal) {
						throw new TaskSubmitError(
							new ApiError("accepted create lost its response", {
								statusCode: 500,
							}),
						);
					}

					publish.resolve();
					return denied;
				},
				script: claim,
				signal: observationSignal,
				storageFactory: () => {
					return createRelayStorage(
						isOriginal
							? { error: "original assertion failed\noriginal stack" }
							: denied.outputs,
						publish.promise,
					);
				},
				timeout: 1000,
			});
		},
	);

	return { executeAsync, signals };
}

function createLatePinnedOriginal() {
	const publishOriginal = Promise.withResolvers<void>();
	const pinnedStarted = Promise.withResolvers<void>();
	const submitted: Array<{ claim: string; script: string; signal: AbortSignal }> = [];
	const outputs = ["pinned original result"];
	const payloads = {
		original: [formatPlaceMismatch(99)],
		pinned: outputs,
		rescue: denied.outputs,
	};
	async function submitAsync(
		kind: "original" | "pinned" | "rescue",
		context: ExecutionAttemptContext,
	) {
		return executeWithResultRelayAsync({
			credentials,
			executeAsync: async (script, signal) => {
				submitted.push({ claim: context.claim, script, signal });
				if (kind === "rescue") {
					publishOriginal.resolve();
					await pinnedStarted.promise;
					return denied;
				}

				if (kind === "pinned") {
					pinnedStarted.resolve();
				}

				throw new TaskSubmitError(
					new ApiError(`${kind} create response lost`, { statusCode: 500 }),
				);
			},
			script: context.claim,
			signal: context.observationSignal,
			storageFactory: () => {
				return createRelayStorage(
					payloads[kind],
					kind === "original" ? publishOriginal.promise : pinnedStarted.promise,
				);
			},
			timeout: 1000,
		});
	}

	const executeAsync = vi.fn<ExecuteAttempt>(async (context) => {
		if (submitted.length > 0) {
			return submitAsync("rescue", context);
		}

		try {
			return await submitAsync("original", context);
		} catch (err) {
			assert.instanceOf(err, ExecutionTimeoutError);
			// Stand in for the backend's late version-guard resolver while
			// keeping the relay and recovery ownership real.
			throw withResultReader(err, async (signal = context.observationSignal) => {
				const refusal = await err.readResultAsync(signal);
				assert.equal(readRefusedPlaceVersion(refusal.outputs[0]), 99);
				return submitAsync("pinned", { ...context, observationSignal: signal });
			});
		}
	});
	return { executeAsync, outputs, submitted };
}

describe("uncertain submission composition", () => {
	it("should retain an accepted original's relayed error when the rescue loses its claim", async () => {
		expect.assertions(4);

		const { executeAsync, signals } = createFailedOriginal();

		await expect(executeWithRecoveryAsync({ executeAsync, timeout: 1000 })).rejects.toThrow(
			"original assertion failed\noriginal stack",
		);

		const claims = new Set(executeAsync.mock.calls.map(([context]) => context.claim));

		expect(executeAsync).toHaveBeenCalledTimes(2);
		expect(claims.size).toBe(1);
		expect(signals.map((signal) => signal.aborted)).toStrictEqual([true, true]);
	});

	it("should share the rescue allowance with an uncertain late pinned submission", async () => {
		expect.assertions(5);

		const { executeAsync, outputs, submitted } = createLatePinnedOriginal();

		await expect(
			executeWithRecoveryAsync({ executeAsync, timeout: 1000 }),
		).resolves.toMatchObject({ outputs });
		expect(executeAsync).toHaveBeenCalledTimes(2);
		expect(submitted).toHaveLength(3);

		const claims = new Set(submitted.map(({ claim }) => claim));
		const relays = new Set(submitted.map(({ script }) => script.split("\n", 1)[0]));

		expect({ claims: claims.size, relays: relays.size }).toStrictEqual({
			claims: 1,
			relays: 3,
		});
		expect(submitted.map(({ signal }) => signal.aborted)).toStrictEqual([true, true, true]);
	});
});
