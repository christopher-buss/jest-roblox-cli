import { createFakeHttpClient, type FakeHttpClient } from "@bedrock-rbx/ocale/testing";

import { type } from "arktype";
import { assert, describe, expect, it } from "vitest";

import { SortedMapInbox } from "./sorted-map-inbox.ts";

const payloadSchema = type("string");

function makeInbox(httpClient: FakeHttpClient): SortedMapInbox<string> {
	return new SortedMapInbox<string>({
		apiKey: "test-key",
		decode: (value) => payloadSchema.assert(value),
		httpClient,
		mapId: "run-1-settle",
		universeId: "123",
	});
}

function validItemBody(id: string, value: string) {
	return {
		id,
		etag: "etag-1",
		expireTime: "2026-06-21T15:08:58.4806559Z",
		path: `cloud/v2/universes/123/memory-store/sorted-maps/run-1-settle/items/${id}`,
		value,
	};
}

describe(SortedMapInbox, () => {
	it("should list every entry with its id across list pages", async () => {
		expect.assertions(2);

		const http = createFakeHttpClient();
		http.mockResponse({
			body: { items: [validItemBody("task-a-1", "first")], nextPageToken: "page-2" },
			status: 200,
		});
		http.mockResponse({ body: { items: [validItemBody("task-b-1", "second")] }, status: 200 });

		const read = await makeInbox(http).readAllAsync();
		assert(read.success, "expected a successful read");

		expect(read.data).toStrictEqual([
			{ id: "task-a-1", value: "first" },
			{ id: "task-b-1", value: "second" },
		]);
		expect(http.requests[1]!.request.url).toContain("pageToken=page-2");
	});

	it("should return the failure when the list call returns an API error", async () => {
		expect.assertions(1);

		const http = createFakeHttpClient();
		http.mockApiError({ message: "Forbidden", statusCode: 403 });

		const read = await makeInbox(http).readAllAsync();
		assert(!read.success, "expected a failed read");

		expect(read.err.message).toContain("Forbidden");
	});

	it("should delete one entry by its id", async () => {
		expect.assertions(2);

		const http = createFakeHttpClient();
		http.mockResponse({ body: {}, status: 200 });

		const deleted = await makeInbox(http).deleteAsync("task-a-1");

		expect(deleted.success).toBeTrue();
		expect(http.requests[0]!.request.url).toContain(
			"/universes/123/memory-store/sorted-maps/run-1-settle/items/task-a-1",
		);
	});

	it("should return the failure when the delete call returns an API error", async () => {
		expect.assertions(1);

		const http = createFakeHttpClient();
		http.mockApiError({ message: "Forbidden", statusCode: 403 });

		const deleted = await makeInbox(http).deleteAsync("task-a-1");
		assert(!deleted.success, "expected a failed delete");

		expect(deleted.err.message).toContain("Forbidden");
	});
});
