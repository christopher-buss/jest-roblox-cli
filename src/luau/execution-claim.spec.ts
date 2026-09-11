import { ApiError, OpenCloudError } from "@bedrock-rbx/ocale";
import type { GetSortedMapItemParameters, SortedMapItem } from "@bedrock-rbx/ocale/storage";
import { StorageClient } from "@bedrock-rbx/ocale/storage";

import { assert, describe, expect, it, vi } from "vitest";

import { ExecutionClaimObserver } from "./execution-claim.ts";

type GetFunc = StorageClient["sortedMaps"]["get"];

function makeStorage(get: GetFunc): StorageClient {
	const storage: StorageClient = Object.create(StorageClient.prototype);
	Object.defineProperty(storage, "sortedMaps", { value: { get } });
	return storage;
}

describe(ExecutionClaimObserver, () => {
	it("should read and decode an execution claim by key", async () => {
		expect.assertions(2);

		const requests: Array<GetSortedMapItemParameters> = [];
		const get = vi.fn<GetFunc>(async (parameters) => {
			requests.push(parameters);
			const item = {
				id: parameters.itemId,
				etag: "etag-1",
				expiresAt: new Date(0),
				mapId: parameters.mapId,
				sortKey: undefined,
				universeId: parameters.universeId,
				value: { claimedAt: 1234, owner: "server-1" },
			} satisfies SortedMapItem;
			return { data: item, success: true };
		});
		const observer = new ExecutionClaimObserver({
			credentials: { apiKey: "test-key", universeId: "123" },
			storageFactory: () => makeStorage(get),
		});

		await expect(observer.readAsync("execution-key")).resolves.toStrictEqual({
			claim: { claimedAt: 1234, owner: "server-1" },
			status: "found",
		});
		expect(requests).toStrictEqual([
			{
				itemId: "execution-key",
				mapId: "jest-roblox-execution-v1",
				universeId: "123",
			},
		]);
	});

	it("should report a missing claim only for an Open Cloud 404", async () => {
		expect.assertions(1);

		const get = vi.fn<GetFunc>(async () => {
			return {
				err: new ApiError("Claim not found", { statusCode: 404 }),
				success: false,
			};
		});
		const observer = new ExecutionClaimObserver({
			credentials: { apiKey: "test-key", universeId: "123" },
			storageFactory: () => makeStorage(get),
		});

		await expect(observer.readAsync("missing-key")).resolves.toStrictEqual({
			status: "missing",
		});
	});

	it("should preserve failures that do not prove the claim is missing", async () => {
		expect.assertions(1);

		const cause = new OpenCloudError("MemoryStore unavailable");
		const get = vi.fn<GetFunc>(async () => ({ err: cause, success: false }));
		const observer = new ExecutionClaimObserver({
			credentials: { apiKey: "test-key", universeId: "123" },
			storageFactory: () => makeStorage(get),
		});

		await expect(observer.readAsync("execution-key")).resolves.toStrictEqual({
			error: cause,
			status: "failed",
		});
	});

	it("should not treat a non-404 API error as a missing claim", async () => {
		expect.assertions(1);

		const cause = new ApiError("Forbidden", { statusCode: 403 });
		const get = vi.fn<GetFunc>(async () => ({ err: cause, success: false }));
		const observer = new ExecutionClaimObserver({
			credentials: { apiKey: "test-key", universeId: "123" },
			storageFactory: () => makeStorage(get),
		});

		await expect(observer.readAsync("execution-key")).resolves.toStrictEqual({
			error: cause,
			status: "failed",
		});
	});

	it("should reject a malformed claim value at the Open Cloud boundary", async () => {
		expect.assertions(2);

		const get = vi.fn<GetFunc>(async (parameters) => {
			return {
				data: {
					id: parameters.itemId,
					etag: "etag-1",
					expiresAt: new Date(0),
					mapId: parameters.mapId,
					sortKey: undefined,
					universeId: parameters.universeId,
					value: { owner: "server-1" },
				},
				success: true,
			};
		});
		const observer = new ExecutionClaimObserver({
			credentials: { apiKey: "test-key", universeId: "123" },
			storageFactory: () => makeStorage(get),
		});

		const observation = await observer.readAsync("execution-key");
		assert(observation.status === "failed", "expected a failed claim observation");

		expect(observation.error.message).toContain("claimedAt must be a number");
		expect(observation.error.cause).toBeDefined();
	});

	it("should construct with the real Open Cloud storage client", () => {
		expect.assertions(1);

		const observer = new ExecutionClaimObserver({
			baseUrl: "http://127.0.0.1:4010",
			credentials: { apiKey: "test-key", universeId: "123" },
		});

		expect(observer).toBeInstanceOf(ExecutionClaimObserver);
	});
});
