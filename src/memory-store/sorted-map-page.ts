import type { OpenCloudClientOptions } from "@bedrock-rbx/ocale";
import type { SortedMapItem } from "@bedrock-rbx/ocale/storage";
import { StorageClient } from "@bedrock-rbx/ocale/storage";

import { omitUndefined } from "../utils/omit-undefined.ts";

const LIST_PAGE_SIZE = 100;

/**
 * The storage client one sorted-map channel reads through, or the one a test
 * stood in. Shared because both channels resolve the same two knobs the same
 * way, and a base URL that reached one but not the other would send a live
 * request from a run pointed at a fake.
 *
 * @param options - The run's credentials, an optional base-URL override, and
 *   the test seam that replaces the client outright.
 * @returns The client to issue sorted-map calls against.
 */
export function resolveStorageClient(options: {
	baseUrl?: string | undefined;
	credentials: { apiKey: string };
	storageFactory?: (() => StorageClient) | undefined;
}): StorageClient {
	if (options.storageFactory !== undefined) {
		return options.storageFactory();
	}

	const clientOptions: OpenCloudClientOptions = omitUndefined({
		apiKey: options.credentials.apiKey,
		baseUrl: options.baseUrl,
	});
	return new StorageClient(clientOptions);
}

/**
 * Walk every page of one SortedMap, decoding each item as it arrives.
 *
 * Shared because both channels the runtime publishes on — the per-package
 * streaming results and the per-test progress heartbeat — are read the same
 * way and differ only in how the item value decodes. `failureLabel` is what
 * the caller calls its own channel, so a key missing `memory-store` scopes
 * names the thing it could not read.
 *
 * `decode` folds each page straight into the result rather than the walk
 * handing back raw items for the caller to map a second time: the streaming
 * poll runs this every 250ms for a whole workspace run.
 *
 * @param options - The map to read, the client to read it through, what to
 *   call the channel in a failure, and how to decode one item.
 * @returns Every item in the map, decoded, in the order the pages arrived.
 */
export async function listSortedMapItemsAsync<T>({
	decode,
	failureLabel,
	mapId,
	storage,
	universeId,
}: {
	decode: (item: SortedMapItem) => T;
	failureLabel: string;
	mapId: string;
	storage: StorageClient;
	universeId: string;
}): Promise<Array<T>> {
	const decoded: Array<T> = [];
	let pageToken: string | undefined;

	do {
		const result = await storage.sortedMaps.list(
			omitUndefined({
				mapId,
				maxPageSize: LIST_PAGE_SIZE,
				pageToken,
				universeId,
			}),
		);
		if (!result.success) {
			throw new Error(`Failed to read ${failureLabel}: ${result.err.message}`, {
				cause: result.err,
			});
		}

		for (const item of result.data.items) {
			decoded.push(decode(item));
		}

		pageToken = result.data.nextPageToken;
	} while (pageToken !== undefined);

	return decoded;
}
