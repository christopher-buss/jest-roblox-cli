import { OpenCloudError } from "@bedrock-rbx/ocale";
import type {
	ListSortedMapItemsParameters,
	ListSortedMapItemsResult,
	SortedMapItem,
} from "@bedrock-rbx/ocale/storage";
import { StorageClient } from "@bedrock-rbx/ocale/storage";
import { fromPartial } from "@total-typescript/shoehorn";

import { describe, expect, it } from "vitest";

import { listSortedMapItemsAsync, resolveStorageClient } from "./sorted-map-page.ts";

function item(id: string): SortedMapItem {
	return fromPartial({ id, etag: "etag", value: id });
}

function storageListing(pages: Array<ListSortedMapItemsResult>, error?: OpenCloudError) {
	const calls: Array<ListSortedMapItemsParameters> = [];
	const storage: StorageClient = Object.create(StorageClient.prototype);
	Object.defineProperty(storage, "sortedMaps", {
		value: {
			list: async (parameters: ListSortedMapItemsParameters) => {
				calls.push(parameters);
				if (error !== undefined) {
					return { err: error, success: false };
				}

				return { data: pages[calls.length - 1], success: true };
			},
		},
	});
	return { calls, storage };
}

describe(resolveStorageClient, () => {
	it("should use the test's client when one is given", () => {
		expect.assertions(1);

		const { storage } = storageListing([]);

		expect(
			resolveStorageClient({ credentials: { apiKey: "key" }, storageFactory: () => storage }),
		).toBe(storage);
	});

	it("should build a storage client from the credentials", () => {
		expect.assertions(1);

		expect(
			resolveStorageClient({ baseUrl: "http://127.0.0.1:1", credentials: { apiKey: "key" } }),
		).toBeInstanceOf(StorageClient);
	});
});

describe(listSortedMapItemsAsync, () => {
	it("should walk every page and decode each item in order", async () => {
		expect.assertions(2);

		const { calls, storage } = storageListing([
			{ items: [item("a"), item("b")], nextPageToken: "next" },
			{ items: [item("c")], nextPageToken: undefined },
		]);

		await expect(
			listSortedMapItemsAsync({
				decode: (entry) => entry.id,
				failureLabel: "results",
				mapId: "map",
				storage,
				universeId: "1",
			}),
		).resolves.toStrictEqual(["a", "b", "c"]);
		expect(calls).toStrictEqual([
			{ mapId: "map", maxPageSize: 100, universeId: "1" },
			{ mapId: "map", maxPageSize: 100, pageToken: "next", universeId: "1" },
		]);
	});

	it("should name the channel it could not read", async () => {
		expect.assertions(1);

		const cause = new OpenCloudError("forbidden");
		const { storage } = storageListing([], cause);

		await expect(
			listSortedMapItemsAsync({
				decode: (entry) => entry,
				failureLabel: "streaming results",
				mapId: "map",
				storage,
				universeId: "1",
			}),
		).rejects.toThrow(
			expect.objectContaining({
				cause,
				message: "Failed to read streaming results: forbidden",
			}),
		);
	});
});
