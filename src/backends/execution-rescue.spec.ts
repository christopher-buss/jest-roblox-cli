import { ApiError } from "@bedrock-rbx/ocale";
import { StorageClient } from "@bedrock-rbx/ocale/storage";
import { type ScriptResult, TaskSubmitError } from "@isentinel/roblox-runner";

import { Buffer } from "node:buffer";
import { zstdCompressSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";

import { EXECUTION_NOT_CLAIMED } from "../luau/execution-claim.ts";
import { executeWithRecoveryAsync, type ExecutionAttemptContext } from "./execution-recovery.ts";
import { executeWithResultRelayAsync } from "./result-relay.ts";

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
});
