import { ApiError } from "@bedrock-rbx/ocale";
import type { StorageClient } from "@bedrock-rbx/ocale/storage";
import type { ScriptResult } from "@isentinel/roblox-runner";
import { ExecutionTimeoutError } from "@isentinel/roblox-runner";

import { type } from "arktype";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { setTimeout as delayAsync } from "node:timers/promises";
import { TextDecoder } from "node:util";
import { zstdDecompressSync } from "node:zlib";

import relaySource from "../../luau/execution-result-relay.luau";
import { countLinesThroughLastDirective } from "../luau/directive-header.ts";
import { resolveStorageClient } from "../memory-store/sorted-map-page.ts";
import { isUncertainTaskSubmit, UncertainSubmissionError } from "./uncertain-submission.ts";

const MAP_ID = "jest-roblox-result-relay-v1";
const POLL_MS = 1000;
const MAX_CHUNKS = 4096;
const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const chunkCountSchema = type("number.integer >= 1").and(`number <= ${MAX_CHUNKS}`);
const uncompressedLengthSchema = type("number.integer >= 0").and(
	`number <= ${MAX_UNCOMPRESSED_BYTES}`,
);
const relayValueSchema = type({
	attempt: "string",
	chunkCount: chunkCountSchema,
	data: "string <= 3500",
	sequence: "number.integer >= 1",
	uncompressedLength: uncompressedLengthSchema,
	version: "1",
});
const outputsSchema = type("string[]").or({ error: "string" });

export interface ResultRelayOptions {
	baseUrl?: string;
	credentials: { apiKey: string; universeId: string };
	executeAsync: (script: string, signal: AbortSignal) => Promise<ScriptResult>;
	now?: () => number;
	runtimeBudget?: number;
	script: string;
	signal?: AbortSignal;
	storageFactory?: () => StorageClient;
	timeout: number;
	waitAsync?: (ms: number, signal: AbortSignal) => Promise<void>;
}

type RelayOutcome = RelayedExecutionError | ScriptResult | undefined;

interface RelayProgress {
	chunks: Array<string>;
	count?: number;
	length: number;
	pendingAcknowledgement: string | undefined;
}

class RelayedExecutionError extends Error {}

// eslint-disable-next-line flawless/max-lines-per-function -- owns both sides of one cancellation race.
export async function executeWithResultRelayAsync(
	options: ResultRelayOptions,
): Promise<ScriptResult> {
	const attempt = randomUUID();
	const deadline = (options.now ?? Date.now)() + options.timeout;
	const observation = new AbortController();
	const signal =
		options.signal === undefined
			? observation.signal
			: AbortSignal.any([options.signal, observation.signal]);

	const lines = options.script.split("\n");
	const directiveLines = countLinesThroughLastDirective(lines);
	const directiveHeader =
		directiveLines === 0 ? "" : `${lines.slice(0, directiveLines).join("\n")}\n`;
	const scriptBody = lines.slice(directiveLines).join("\n");
	const runtimeBudgetSeconds = Math.min(
		Math.floor((options.runtimeBudget ?? options.timeout) / 1000),
		300,
	);
	const wrapped =
		directiveHeader +
		relaySource
			.split("__RESULT_RELAY_ATTEMPT__")
			.join(attempt)
			.split("-- __RESULT_RELAY_RUNTIME_BUDGET__")
			.join(`local publishBudgetSeconds = ${runtimeBudgetSeconds.toString()}`)
			.split("-- __RESULT_RELAY_SCRIPT__")
			.join(scriptBody);
	const initialRead = new AbortController();
	const progress: RelayProgress = { chunks: [], length: 0, pendingAcknowledgement: undefined };
	const storage = Promise.resolve().then(() => resolveStorageClient(options));
	let completedResult: RelayOutcome;
	const relay = readAsync(AbortSignal.any([signal, initialRead.signal]));
	let isRecovering = false;

	async function readAsync(parentSignal: AbortSignal): Promise<RelayOutcome> {
		try {
			completedResult = await readRelayAsync({
				attempt,
				options,
				progress,
				signal: AbortSignal.any([parentSignal, AbortSignal.timeout(options.timeout)]),
				storage: await storage,
			});
			return completedResult;
		} catch (err) {
			return err instanceof RelayedExecutionError ? err : undefined;
		}
	}

	try {
		const native = options.executeAsync(wrapped, signal);
		return await Promise.race([native, relay.then(resultOrNeverAsync)]);
	} catch (err) {
		if (isUncertainTaskSubmit(err) && !signal.aborted) {
			isRecovering = true;
			throw new UncertainSubmissionError(err, async (recoverySignal) => {
				const readingSignal =
					recoverySignal === undefined
						? signal
						: AbortSignal.any([signal, recoverySignal]);
				try {
					readingSignal.throwIfAborted();
					return await Promise.race([
						relay.then(async (result) => {
							if (result === undefined) {
								throw err;
							}

							return resultOrNeverAsync(result);
						}),
						delayAsync(Math.max(0, deadline - (options.now ?? Date.now)()), undefined, {
							signal: readingSignal,
						}).then(() => {
							throw err;
						}),
					]);
				} finally {
					observation.abort();
				}
			});
		}

		if (!(err instanceof ExecutionTimeoutError) || signal.aborted) {
			throw err;
		}

		isRecovering = true;
		initialRead.abort();
		// Keep draining while the hedge runs: the publisher requires prompt
		// acknowledgements.
		const continued = relay.then(async (result) => result ?? readAsync(signal));
		throw new ExecutionTimeoutError(err, async (recoverySignal) => {
			const readingSignal =
				recoverySignal === undefined ? signal : AbortSignal.any([signal, recoverySignal]);
			try {
				readingSignal.throwIfAborted();
				if (completedResult !== undefined) {
					return await resultOrNeverAsync(completedResult);
				}

				return await Promise.race([
					err.readResultAsync(readingSignal),
					continued
						.then(async (result) => result ?? readAsync(readingSignal))
						.then(resultOrNeverAsync),
				]);
			} finally {
				observation.abort();
			}
		});
	} finally {
		if (!isRecovering) {
			observation.abort();
		}
	}
}

async function neverAsync(): Promise<never> {
	return new Promise<never>(() => {
		/* Relay absence deliberately defers to the native result. */
	});
}

async function resultOrNeverAsync(result: RelayOutcome): Promise<ScriptResult> {
	if (result instanceof RelayedExecutionError) {
		throw result;
	}

	return result ?? neverAsync();
}

async function waitAsync(ms: number, signal: AbortSignal): Promise<void> {
	await delayAsync(ms, undefined, { signal });
}

// eslint-disable-next-line flawless/max-lines-per-function, sonar/cognitive-complexity -- sequential wire protocol validation stays together.
async function readRelayAsync({
	attempt,
	options,
	progress,
	signal,
	storage,
}: {
	attempt: string;
	options: ResultRelayOptions;
	progress: RelayProgress;
	signal: AbortSignal;
	storage: StorageClient;
}): Promise<ScriptResult | undefined> {
	const now = options.now ?? Date.now;
	const start = now();
	const { chunks } = progress;
	while (true) {
		if (progress.pendingAcknowledgement !== undefined) {
			const deleted = await storage.sortedMaps.delete(
				{
					itemId: progress.pendingAcknowledgement,
					mapId: MAP_ID,
					universeId: options.credentials.universeId,
				},
				{ signal },
			);
			if (
				!deleted.success &&
				(!(deleted.err instanceof ApiError) || deleted.err.statusCode !== 404)
			) {
				throw deleted.err;
			}

			progress.pendingAcknowledgement = undefined;
		}

		if (chunks.length === progress.count) {
			break;
		}

		const sequence = chunks.length + 1;
		const key = `${attempt}:${sequence.toString()}`;
		let value: typeof relayValueSchema.infer | undefined;
		while (value === undefined) {
			if (now() - start >= options.timeout) {
				return undefined;
			}

			const result = await storage.sortedMaps.get(
				{ itemId: key, mapId: MAP_ID, universeId: options.credentials.universeId },
				{ signal },
			);
			if (result.success) {
				value = relayValueSchema.assert(result.data.value);
			} else if (!(result.err instanceof ApiError) || result.err.statusCode !== 404) {
				throw result.err;
			} else {
				await (options.waitAsync ?? waitAsync)(chunks.length === 0 ? POLL_MS : 100, signal);
			}
		}

		if (
			value.attempt !== attempt ||
			value.sequence !== sequence ||
			(progress.count !== undefined && value.chunkCount !== progress.count) ||
			(progress.count !== undefined && value.uncompressedLength !== progress.length)
		) {
			return undefined;
		}

		progress.count = value.chunkCount;
		progress.length = value.uncompressedLength;
		chunks.push(value.data);
		progress.pendingAcknowledgement = key;
	}

	const decoded = zstdDecompressSync(Buffer.from(chunks.join(""), "base64"), {
		maxOutputLength: Math.max(1, progress.length),
	});
	if (decoded.byteLength !== progress.length) {
		return undefined;
	}

	const decoder = new TextDecoder("utf-8", { fatal: true });
	const json = decoder.decode(decoded);
	const outputs = outputsSchema.assert(JSON.parse(json));
	if (!Array.isArray(outputs)) {
		throw new RelayedExecutionError(outputs.error);
	}

	return { durationMs: now() - start, outputs };
}
