import { OpenCloudError } from "@bedrock-rbx/ocale";
import type {
	ListSortedMapItemsParameters,
	ListSortedMapItemsResult,
	SortedMapItem,
} from "@bedrock-rbx/ocale/storage";
import { StorageClient } from "@bedrock-rbx/ocale/storage";

import { describe, expect, it, vi } from "vitest";

import { decodeTestProgress, TestProgressClient } from "./test-progress.ts";

type ListFunc = StorageClient["sortedMaps"]["list"];

interface StubBehavior {
	listError?: OpenCloudError;
	listPages?: Array<ListSortedMapItemsResult>;
}

function createStorageStub(behavior: StubBehavior = {}): {
	listCalls: Array<ListSortedMapItemsParameters>;
	storage: StorageClient;
} {
	const listCalls: Array<ListSortedMapItemsParameters> = [];
	const list = vi.fn<ListFunc>(async (parameters) => {
		listCalls.push(parameters);
		if (behavior.listError !== undefined) {
			return { err: behavior.listError, success: false };
		}

		const pages = behavior.listPages ?? [{ items: [], nextPageToken: undefined }];
		const page = pages[listCalls.length - 1];
		if (page === undefined) {
			throw new Error(`Unexpected sortedMaps.list call ${String(listCalls.length)}`);
		}

		return { data: page, success: true };
	});

	const storage: StorageClient = Object.create(StorageClient.prototype);
	Object.defineProperty(storage, "sortedMaps", { value: { list } });
	return { listCalls, storage };
}

function progressValue(overrides: Record<string, JSONValue> = {}): JSONObject {
	return {
		elapsedMs: 4200,
		state: "started",
		testFilePath: "ReplicatedStorage/shared/wedge.spec",
		testName: "wedges > never returns",
		...overrides,
	};
}

function item(id: string, value: JSONObject): SortedMapItem {
	return {
		id,
		etag: "etag",
		expiresAt: new Date(0),
		mapId: "progress-map",
		sortKey: undefined,
		universeId: "123",
		value,
	};
}

const CREDENTIALS = { apiKey: "key", universeId: "123" };

describe(decodeTestProgress, () => {
	it("should decode a well-formed progress record", () => {
		expect.assertions(1);

		expect(decodeTestProgress(progressValue())).toStrictEqual({
			elapsedMs: 4200,
			state: "started",
			testFilePath: "ReplicatedStorage/shared/wedge.spec",
			testName: "wedges > never returns",
		});
	});

	it("should reject a record whose state is not a known phase", () => {
		expect.assertions(1);

		expect(() => decodeTestProgress(progressValue({ state: "midway" }))).toThrow(/state/);
	});
});

describe(TestProgressClient, () => {
	it("should read every page of progress records", async () => {
		expect.assertions(2);

		const stub = createStorageStub({
			listPages: [
				{ items: [item("task-a", progressValue())], nextPageToken: "next" },
				{
					items: [
						item("task-b", progressValue({ state: "completed", testName: "b > ok" })),
					],
					nextPageToken: undefined,
				},
			],
		});
		const client = new TestProgressClient({
			credentials: CREDENTIALS,
			mapId: "progress-map",
			storageFactory: () => stub.storage,
		});

		const records = await client.readAllAsync();

		expect(records).toHaveLength(2);
		expect(records[1]).toStrictEqual({
			elapsedMs: 4200,
			state: "completed",
			testFilePath: "ReplicatedStorage/shared/wedge.spec",
			testName: "b > ok",
		});
	});

	it("should build a real storage client against the given base url", async () => {
		expect.assertions(1);

		const client = new TestProgressClient({
			baseUrl: "https://example.invalid",
			credentials: CREDENTIALS,
			mapId: "progress-map",
		});

		// Nothing is dispatched until a read, so the failure below proves the
		// client was built rather than that the host answered.
		await expect(client.readAllAsync()).rejects.toThrow(/./);
	});

	// The wedge banner is best-effort: `rethrowWedgeAsync` swallows this and
	// reports the bare timeout instead. The cause still has to ride along, so
	// a caller that does surface it can say which scope the key is missing.
	it("should throw when the list call fails, carrying the cause", async () => {
		expect.assertions(2);

		const listError = new OpenCloudError("no scope");
		const stub = createStorageStub({ listError });
		const client = new TestProgressClient({
			credentials: CREDENTIALS,
			mapId: "progress-map",
			storageFactory: () => stub.storage,
		});

		const caught = await client.readAllAsync().catch((err: unknown) => err);

		expect(caught).toHaveProperty("message", "Failed to read test progress: no scope");
		expect(caught).toHaveProperty("cause", listError);
	});
});
