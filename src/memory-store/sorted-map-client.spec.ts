import type {
	CreateSortedMapItemParameters,
	DeleteSortedMapItemParameters,
	ListSortedMapItemsParameters,
	ListSortedMapItemsResult,
	SortedMapItem,
} from "@bedrock-rbx/ocale/storage";
import { StorageClient } from "@bedrock-rbx/ocale/storage";

import { describe, expect, it, vi } from "vitest";

import {
	decodeStreamingResult,
	encodeStreamingResult,
	StreamingResultClient,
	type StreamingResultEntry,
} from "./sorted-map-client.ts";

interface SortedMapStub {
	createCalls: Array<CreateSortedMapItemParameters>;
	deleteCalls: Array<DeleteSortedMapItemParameters>;
	listCalls: Array<ListSortedMapItemsParameters>;
	storage: StorageClient;
}

interface StubBehavior {
	createError?: { message: string };
	deleteError?: { message: string };
	listError?: { message: string };
	listPages?: Array<ListSortedMapItemsResult>;
}

type CreateFunc = StorageClient["sortedMaps"]["create"];
type DeleteFunc = StorageClient["sortedMaps"]["delete"];
type ListFunc = StorageClient["sortedMaps"]["list"];

function createSortedMapStub(behavior: StubBehavior = {}): SortedMapStub {
	const createCalls: Array<CreateSortedMapItemParameters> = [];
	const deleteCalls: Array<DeleteSortedMapItemParameters> = [];
	const listCalls: Array<ListSortedMapItemsParameters> = [];

	const create = vi.fn<CreateFunc>(async (parameters) => {
		createCalls.push(parameters);
		if (behavior.createError !== undefined) {
			return { err: behavior.createError as never, success: false };
		}

		const item: SortedMapItem = {
			id: parameters.itemId,
			etag: "etag-1",
			expiresAt: new Date(0),
			mapId: parameters.mapId,
			sortKey: parameters.sortKey,
			universeId: parameters.universeId,
			value: parameters.value,
		};
		return { data: item, success: true };
	});

	const remove = vi.fn<DeleteFunc>(async (parameters) => {
		deleteCalls.push(parameters);
		if (behavior.deleteError !== undefined) {
			return { err: behavior.deleteError as never, success: false };
		}

		return { data: undefined, success: true };
	});

	const list = vi.fn<ListFunc>(async (parameters) => {
		listCalls.push(parameters);
		if (behavior.listError !== undefined) {
			return { err: behavior.listError as never, success: false };
		}

		const pages = behavior.listPages ?? [{ items: [], nextPageToken: undefined }];
		const callIndex = listCalls.length - 1;
		const page = pages[callIndex] ?? { items: [], nextPageToken: undefined };
		return { data: page, success: true };
	});

	const storage: StorageClient = Object.create(StorageClient.prototype);
	Object.defineProperty(storage, "sortedMaps", {
		value: { create, delete: remove, list },
	});

	return { createCalls, deleteCalls, listCalls, storage };
}

const CREDENTIALS = { apiKey: "test-key", universeId: "123" };

function makeEntry(overrides: Partial<StreamingResultEntry> = {}): StreamingResultEntry {
	return {
		elapsedMs: 1,
		numFailedTests: 0,
		numPassedTests: 1,
		numPendingTests: 0,
		pkg: "a",
		project: "b",
		success: true,
		...overrides,
	};
}

function makeItem(overrides: Partial<SortedMapItem> & { id: string }): SortedMapItem {
	return {
		etag: "etag",
		expiresAt: new Date(0),
		mapId: "map-1",
		sortKey: undefined,
		universeId: "123",
		value: encodeStreamingResult(makeEntry({ pkg: "x", project: "y" })),
		...overrides,
	};
}

describe(StreamingResultClient, () => {
	describe("write", () => {
		it("should call sortedMaps.create with the map id, item id, and encoded summary", async () => {
			expect.assertions(2);

			const stub = createSortedMapStub();
			const client = new StreamingResultClient({
				credentials: CREDENTIALS,
				mapId: "results-uuid",
				storageFactory: () => stub.storage,
			});

			await client.write(
				makeEntry({
					elapsedMs: 1234,
					numFailedTests: 2,
					numPassedTests: 5,
					numPendingTests: 1,
					pkg: "@halcyon/foo",
					project: "alpha",
					success: false,
				}),
			);

			expect(stub.createCalls).toHaveLength(1);
			expect(stub.createCalls[0]).toStrictEqual({
				itemId: "@halcyon/foo::alpha",
				mapId: "results-uuid",
				ttl: 600,
				universeId: "123",
				value: {
					elapsedMs: 1234,
					numFailedTests: 2,
					numPassedTests: 5,
					numPendingTests: 1,
					pkg: "@halcyon/foo",
					project: "alpha",
					success: false,
				},
			});
		});

		it("should accept a custom ttlSeconds override", async () => {
			expect.assertions(1);

			const stub = createSortedMapStub();
			const client = new StreamingResultClient({
				credentials: CREDENTIALS,
				mapId: "m",
				storageFactory: () => stub.storage,
				ttlSeconds: 120,
			});

			await client.write(makeEntry());

			expect(stub.createCalls[0]?.ttl).toBe(120);
		});

		it("should throw when sortedMaps.create returns a failure Result", async () => {
			expect.assertions(1);

			const stub = createSortedMapStub({ createError: { message: "rate limited" } });
			const client = new StreamingResultClient({
				credentials: CREDENTIALS,
				mapId: "m",
				storageFactory: () => stub.storage,
			});

			await expect(client.write(makeEntry())).rejects.toThrow(
				"Failed to write streaming result: rate limited",
			);
		});
	});

	describe("readAll", () => {
		it("should return an empty array when the map has no items", async () => {
			expect.assertions(1);

			const stub = createSortedMapStub();
			const client = new StreamingResultClient({
				credentials: CREDENTIALS,
				mapId: "m",
				storageFactory: () => stub.storage,
			});

			const results = await client.readAll();

			expect(results).toStrictEqual([]);
		});

		it("should request a maxPageSize of 100 when listing", async () => {
			expect.assertions(1);

			const stub = createSortedMapStub();
			const client = new StreamingResultClient({
				credentials: CREDENTIALS,
				mapId: "m",
				storageFactory: () => stub.storage,
			});

			await client.readAll();

			expect(stub.listCalls[0]?.maxPageSize).toBe(100);
		});

		it("should decode each item's value into a StreamingResultEntry", async () => {
			expect.assertions(1);

			const decoded = makeEntry({
				elapsedMs: 50,
				numPassedTests: 4,
				pkg: "a",
				project: "p",
			});
			const stub = createSortedMapStub({
				listPages: [
					{
						items: [makeItem({ id: "a::p", value: encodeStreamingResult(decoded) })],
						nextPageToken: undefined,
					},
				],
			});
			const client = new StreamingResultClient({
				credentials: CREDENTIALS,
				mapId: "m",
				storageFactory: () => stub.storage,
			});

			const results = await client.readAll();

			expect(results).toStrictEqual([{ id: "a::p", value: decoded }]);
		});

		it("should follow nextPageToken through every page", async () => {
			expect.assertions(2);

			const stub = createSortedMapStub({
				listPages: [
					{
						items: [
							makeItem({
								id: "a::p",
								value: encodeStreamingResult(makeEntry({ pkg: "a", project: "p" })),
							}),
						],
						nextPageToken: "page-2",
					},
					{
						items: [
							makeItem({
								id: "b::q",
								value: encodeStreamingResult(makeEntry({ pkg: "b", project: "q" })),
							}),
						],
						nextPageToken: undefined,
					},
				],
			});
			const client = new StreamingResultClient({
				credentials: CREDENTIALS,
				mapId: "m",
				storageFactory: () => stub.storage,
			});

			const results = await client.readAll();

			expect(results.map((entry) => entry.id)).toStrictEqual(["a::p", "b::q"]);
			expect(stub.listCalls[1]?.pageToken).toBe("page-2");
		});

		it("should throw when sortedMaps.list returns a failure Result", async () => {
			expect.assertions(1);

			const stub = createSortedMapStub({ listError: { message: "auth failed" } });
			const client = new StreamingResultClient({
				credentials: CREDENTIALS,
				mapId: "m",
				storageFactory: () => stub.storage,
			});

			await expect(client.readAll()).rejects.toThrow(
				"Failed to read streaming results: auth failed",
			);
		});

		it("should throw when an item's value fails decoding", async () => {
			expect.assertions(1);

			const stub = createSortedMapStub({
				listPages: [
					{
						items: [makeItem({ id: "a::p", value: { pkg: "a" } })],
						nextPageToken: undefined,
					},
				],
			});
			const client = new StreamingResultClient({
				credentials: CREDENTIALS,
				mapId: "m",
				storageFactory: () => stub.storage,
			});

			await expect(client.readAll()).rejects.toThrow("project must be a string");
		});
	});

	describe("delete", () => {
		it("should call sortedMaps.delete with the map id and item id", async () => {
			expect.assertions(1);

			const stub = createSortedMapStub();
			const client = new StreamingResultClient({
				credentials: CREDENTIALS,
				mapId: "results-uuid",
				storageFactory: () => stub.storage,
			});

			await client.delete("a::p");

			expect(stub.deleteCalls[0]).toStrictEqual({
				itemId: "a::p",
				mapId: "results-uuid",
				universeId: "123",
			});
		});

		it("should throw when sortedMaps.delete returns a failure Result", async () => {
			expect.assertions(1);

			const stub = createSortedMapStub({ deleteError: { message: "not found" } });
			const client = new StreamingResultClient({
				credentials: CREDENTIALS,
				mapId: "m",
				storageFactory: () => stub.storage,
			});

			await expect(client.delete("a::p")).rejects.toThrow(
				"Failed to delete streaming result: not found",
			);
		});
	});

	describe("default storage factory", () => {
		it("should construct a real StorageClient when no factory is provided", () => {
			expect.assertions(1);

			const client = new StreamingResultClient({
				credentials: CREDENTIALS,
				mapId: "m",
			});

			expect(client).toBeInstanceOf(StreamingResultClient);
		});

		it("should construct a real StorageClient with a custom baseUrl when provided", () => {
			expect.assertions(1);

			const client = new StreamingResultClient({
				baseUrl: "http://127.0.0.1:4010",
				credentials: CREDENTIALS,
				mapId: "m",
			});

			expect(client).toBeInstanceOf(StreamingResultClient);
		});
	});
});

describe(encodeStreamingResult, () => {
	it("should round-trip a streaming entry through encode/decode unchanged", () => {
		expect.assertions(1);

		const entry = makeEntry({
			elapsedMs: 42,
			numFailedTests: 1,
			numPassedTests: 7,
			numPendingTests: 0,
			pkg: "@halcyon/foo",
			project: "alpha",
			success: false,
		});

		expect(decodeStreamingResult(encodeStreamingResult(entry))).toStrictEqual(entry);
	});
});

describe(decodeStreamingResult, () => {
	it("should throw when wire payload is missing required fields", () => {
		expect.assertions(1);

		expect(() => decodeStreamingResult({ elapsedMs: 0, pkg: "a", project: "b" })).toThrow(
			"numFailedTests must be a number",
		);
	});

	it("should throw when wire payload field has wrong type", () => {
		expect.assertions(1);

		expect(() => {
			return decodeStreamingResult({
				elapsedMs: "fast",
				numFailedTests: 0,
				numPassedTests: 1,
				numPendingTests: 0,
				pkg: "a",
				project: "b",
				success: true,
			});
		}).toThrow("elapsedMs must be a number");
	});

	it("should throw when wire payload is not an object", () => {
		expect.assertions(1);

		expect(() => decodeStreamingResult("not-an-object")).toThrow("must be an object");
	});
});
