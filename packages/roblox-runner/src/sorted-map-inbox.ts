import type { OpenCloudError, Result } from "@bedrock-rbx/ocale";
import type { ListSortedMapItemsParameters, StorageClient } from "@bedrock-rbx/ocale/storage";

import type { PacedConnection } from "./client-options.ts";
import { createStorageClient } from "./client-options.ts";

/**
 * Transport and decoding policy for one run-owned SortedMap.
 *
 * @template T
 */
export interface SortedMapInboxOptions<T> extends PacedConnection {
	/**
	 * Parse each SDK JSON value into the consumer domain type.
	 */
	readonly decode: (value: JSONValue) => T;
	/**
	 * Run-owned SortedMap to inspect and clear.
	 */
	readonly mapId: string;
}

/**
 * Decoded value paired with the key the consumer acknowledges.
 *
 * @template T
 */
export interface SortedMapEntry<T> {
	/**
	 * MemoryStore item key used to delete the consumed entry.
	 */
	readonly id: string;
	/**
	 * Decoded item value, kept with its deletion key.
	 */
	readonly value: T;
}

/** Page size for the list sweep; the server caps it at 100. */
const PAGE_SIZE = 100;

/**
 * Host side of a MemoryStore SortedMap the Luau tasks write: list every entry
 * with its key, and delete the ones consumed. Injectable (fake `httpClient`)
 * for tests.
 * @template T
 */
export class SortedMapInbox<T> {
	private readonly decode: (value: JSONValue) => T;
	private readonly mapId: string;
	private readonly storage: StorageClient;
	private readonly universeId: string;

	/**
	 * Bind a run-owned SortedMap to its decoder and transport.
	 * @param options - SortedMap identity, SDK overrides and payload decoder.
	 */
	constructor(options: SortedMapInboxOptions<T>) {
		this.decode = options.decode;
		this.mapId = options.mapId;
		this.universeId = options.universeId;
		this.storage = createStorageClient(options);
	}

	/**
	 * Delete one consumed SortedMap item, preserving SDK failures as values.
	 * @param itemId - Key of the consumed SortedMap item.
	 * @returns The SDK deletion result, preserving failures for the caller.
	 */
	public async deleteAsync(itemId: string): Promise<Result<undefined, OpenCloudError>> {
		const deleted = await this.storage.sortedMaps.delete({
			itemId,
			mapId: this.mapId,
			universeId: this.universeId,
		});
		return deleted.success ? { data: undefined, success: true } : deleted;
	}

	/**
	 * List every entry and decode its value. Pages through the list until the
	 * server stops returning a continuation token.
	 * @returns Decoded entries from all pages of the selected SortedMap.
	 */
	public async readAllAsync(): Promise<Result<Array<SortedMapEntry<T>>, OpenCloudError>> {
		const entries: Array<SortedMapEntry<T>> = [];
		let pageToken: string | undefined;

		do {
			let parameters: ListSortedMapItemsParameters = {
				mapId: this.mapId,
				maxPageSize: PAGE_SIZE,
				universeId: this.universeId,
			};
			if (pageToken !== undefined) {
				parameters = { ...parameters, pageToken };
			}

			const result = await this.storage.sortedMaps.list(parameters);
			if (!result.success) {
				return result;
			}

			for (const item of result.data.items) {
				entries.push({ id: item.id, value: this.decode(item.value) });
			}

			pageToken = result.data.nextPageToken;
		} while (pageToken !== undefined);

		return { data: entries, success: true };
	}
}
