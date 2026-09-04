import type { CreateSortedMapItemParameters, StorageClient } from "@bedrock-rbx/ocale/storage";

import { type } from "arktype";

import { listSortedMapItemsAsync, resolveStorageClient } from "./sorted-map-page.ts";

const DEFAULT_TTL_SECONDS = 600;

const streamingResultSchema = type({
	elapsedMs: "number",
	numFailedTests: "number",
	numPassedTests: "number",
	numPendingTests: "number",
	pkg: "string",
	project: "string",
	success: "boolean",
});

/**
 * Slim per-package summary published mid-task via the MemoryStore SortedMap.
 * Intentionally compact — Roblox caps SortedMap items at 32 KB, so we leave
 * the full `jestOutput` JSON out of streaming and reconstruct it from the
 * task's final envelope. Streaming only needs enough fields to render a
 * one-line progress message.
 */
export interface StreamingResultEntry {
	elapsedMs: number;
	numFailedTests: number;
	numPassedTests: number;
	numPendingTests: number;
	pkg: string;
	project: string;
	success: boolean;
}

export interface StreamingResultRecord {
	id: string;
	value: StreamingResultEntry;
}

/**
 * Minimal surface used by streaming polling — lets backends and tests
 * stand in a stub without depending on the SDK class hierarchy.
 */
export interface StreamingResultReader {
	deleteAsync(itemId: string): Promise<void>;
	readAllAsync(): Promise<Array<StreamingResultRecord>>;
}

export interface StreamingResultClientOptions {
	/** Override the Open Cloud base URL (default: live Roblox endpoint). */
	baseUrl?: string | undefined;
	credentials: { apiKey: string; universeId: string };
	/**
	 * Per-run UUID-keyed sorted-map identifier shared between materializer and
	 * CLI.
	 */
	mapId: string;
	/** Override the StorageClient factory (default: real client). Test seam. */
	storageFactory?: () => StorageClient;
	/** TTL for written items in seconds. Default 600 (10 min). */
	ttlSeconds?: number;
}

/**
 * Thin facade over `StorageClient.sortedMaps` for the streaming-result
 * envelope. The materializer writes one item per package result keyed by
 * `<pkg>::<project>`; the CLI lists all current items, drives the
 * aggregator with each, then deletes consumed items so they aren't
 * re-emitted on the next poll.
 */
export class StreamingResultClient {
	private readonly mapId: string;
	private readonly storage: StorageClient;
	private readonly ttlSeconds: number;
	private readonly universeId: string;

	constructor(options: StreamingResultClientOptions) {
		this.mapId = options.mapId;
		this.universeId = options.credentials.universeId;
		this.ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
		this.storage = resolveStorageClient(options);
	}

	public async deleteAsync(itemId: string): Promise<void> {
		const result = await this.storage.sortedMaps.delete({
			itemId,
			mapId: this.mapId,
			universeId: this.universeId,
		});
		if (!result.success) {
			throw new Error(`Failed to delete streaming result: ${result.err.message}`, {
				cause: result.err,
			});
		}
	}

	public async readAllAsync(): Promise<Array<StreamingResultRecord>> {
		return listSortedMapItemsAsync({
			decode: (item) => ({ id: item.id, value: decodeStreamingResult(item.value) }),
			failureLabel: "streaming results",
			mapId: this.mapId,
			storage: this.storage,
			universeId: this.universeId,
		});
	}

	public async writeAsync(entry: StreamingResultEntry): Promise<void> {
		const parameters: CreateSortedMapItemParameters = {
			itemId: itemIdFor(entry),
			mapId: this.mapId,
			ttl: this.ttlSeconds,
			universeId: this.universeId,
			value: { ...entry },
		};
		const result = await this.storage.sortedMaps.create(parameters);
		if (!result.success) {
			throw new Error(`Failed to write streaming result: ${result.err.message}`, {
				cause: result.err,
			});
		}
	}
}

/**
 * Validates the wire payload against the StreamingResultEntry shape; throws on
 * mismatch.
 */
export function decodeStreamingResult(value: JSONValue): StreamingResultEntry {
	return streamingResultSchema.assert(value);
}

/**
 * Builds the SortedMap item identifier. Relies on the invariant that
 * neither `pkg` nor `project` contains `::` — npm package names disallow
 * it, and project displayNames are validated upstream. If that ever
 * changes the join token needs to become a character that's banned by
 * both naming rules (e.g. a control character or null byte).
 */
function itemIdFor(entry: StreamingResultEntry): string {
	return `${entry.pkg}::${entry.project}`;
}
