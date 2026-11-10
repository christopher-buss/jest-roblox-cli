import type { OpenCloudClientOptions } from "@bedrock-rbx/ocale";
import { StorageClient } from "@bedrock-rbx/ocale/storage";

import { isDefined, pickBy } from "remeda";

import { type StreamingResultEntry, streamingResultSchema } from "../protocol/streaming-summary.ts";

const LIST_PAGE_SIZE = 100;

/** One SortedMap item as read back from the map. */
export interface StreamingResultRecord {
	/** SortedMap item ID, `<pkg>::<project>`. */
	id: string;
	/** Decoded item payload. */
	value: StreamingResultEntry;
}

/** Surface streaming polling reads through. */
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
	/** Per-run sorted-map ID shared with the materializer. */
	mapId: string;
	/** Override the StorageClient factory (default: real client). Test seam. */
	storageFactory?: () => StorageClient;
}

/** Reads and deletes streamed results in one SortedMap. */
export class StreamingResultClient {
	private readonly mapId: string;
	private readonly storage: StorageClient;
	private readonly universeId: string;

	/**
	 * Bind the client to one map and its storage client.
	 * @param options - Map ID, credentials and storage seam.
	 */
	constructor(options: StreamingResultClientOptions) {
		this.mapId = options.mapId;
		this.universeId = options.credentials.universeId;
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
		const records: Array<StreamingResultRecord> = [];
		let pageToken: string | undefined;

		do {
			const result = await this.storage.sortedMaps.list(
				pickBy(
					{
						mapId: this.mapId,
						maxPageSize: LIST_PAGE_SIZE,
						pageToken,
						universeId: this.universeId,
					},
					isDefined,
				),
			);
			if (!result.success) {
				throw new Error(`Failed to read streaming results: ${result.err.message}`, {
					cause: result.err,
				});
			}

			for (const item of result.data.items) {
				records.push({ id: item.id, value: streamingResultSchema.assert(item.value) });
			}

			pageToken = result.data.nextPageToken;
		} while (pageToken !== undefined);

		return records;
	}
}

function resolveStorageClient(options: StreamingResultClientOptions): StorageClient {
	if (options.storageFactory !== undefined) {
		return options.storageFactory();
	}

	const clientOptions: OpenCloudClientOptions = pickBy(
		{
			apiKey: options.credentials.apiKey,
			baseUrl: options.baseUrl,
		},
		isDefined,
	);
	return new StorageClient(clientOptions);
}
