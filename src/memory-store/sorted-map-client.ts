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
	/** Wall time the package run took, in milliseconds. */
	elapsedMs: number;
	/** Failed test count. */
	numFailedTests: number;
	/** Passed test count. */
	numPassedTests: number;
	/** Pending (skipped or todo) test count. */
	numPendingTests: number;
	/** Package name. */
	pkg: string;
	/** Jest project display name within the package. */
	project: string;
	/** Whether the package run passed. */
	success: boolean;
}

/** One SortedMap item as read back from the map. */
export interface StreamingResultRecord {
	/** SortedMap item ID, `<pkg>::<project>`. */
	id: string;
	/** Decoded item payload. */
	value: StreamingResultEntry;
}

/**
 * Minimal surface used by streaming polling — lets backends and tests
 * stand in a stub without depending on the SDK class hierarchy.
 */
export interface StreamingResultReader {
	/**
	 * Delete one item from the map.
	 * @param itemId - ID of the item to delete.
	 * @returns Resolves once the item is deleted.
	 */
	deleteAsync(itemId: string): Promise<void>;
	/**
	 * Read every current item in the map.
	 * @returns Every item, decoded.
	 */
	readAllAsync(): Promise<Array<StreamingResultRecord>>;
}

/** Map, credentials and test seams for a `StreamingResultClient`. */
export interface StreamingResultClientOptions {
	/** Override the Open Cloud base URL (default: live Roblox endpoint). */
	baseUrl?: string | undefined;
	/** Open Cloud API key and the universe that owns the map. */
	credentials: {
		/** Open Cloud API key with MemoryStore access. */
		apiKey: string;
		/** Universe that owns the map. */
		universeId: string;
	};
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

	/**
	 * Bind the client to one map and its storage client.
	 * @param options - Map ID, credentials, TTL and storage seam.
	 */
	constructor(options: StreamingResultClientOptions) {
		this.mapId = options.mapId;
		this.universeId = options.credentials.universeId;
		this.ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
		this.storage = resolveStorageClient(options);
	}

	/**
	 * Delete one item from the map.
	 * @param itemId - ID of the item to delete.
	 * @returns Resolves once the item is deleted.
	 * @rejects When the storage API refuses the delete.
	 */
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

	/**
	 * Read every current item in the map.
	 * @returns Every item, decoded.
	 * @rejects When a page read fails or an item fails to decode.
	 */
	public async readAllAsync(): Promise<Array<StreamingResultRecord>> {
		return listSortedMapItemsAsync({
			decode: (item) => ({ id: item.id, value: decodeStreamingResult(item.value) }),
			failureLabel: "streaming results",
			mapId: this.mapId,
			storage: this.storage,
			universeId: this.universeId,
		});
	}

	/**
	 * Write one package result as a map item with the configured TTL.
	 * @param entry - Package result to publish.
	 * @returns Resolves once the item is written.
	 * @rejects When the storage API refuses the write.
	 */
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
 * @param value - Wire payload of one SortedMap item.
 * @returns The validated entry.
 */
function decodeStreamingResult(value: JSONValue): StreamingResultEntry {
	return streamingResultSchema.assert(value);
}

/**
 * Builds the SortedMap item identifier. Relies on the invariant that
 * neither `pkg` nor `project` contains `::` — npm package names disallow
 * it, and project displayNames are validated upstream. If that ever
 * changes the join token needs to become a character that's banned by
 * both naming rules, such as a control character or null byte.
 * @param entry - Entry whose `pkg` and `project` form the ID.
 * @returns The `<pkg>::<project>` item ID.
 */
function itemIdFor(entry: StreamingResultEntry): string {
	return `${entry.pkg}::${entry.project}`;
}
