import {
	createFakeHttpClient,
	type FakeHttpClient,
	validDequeueBody,
	validQueueItemBody,
} from "@bedrock-rbx/ocale/testing";

import { assert, describe, expect, it } from "vitest";

import { createWorkQueueStorage, dequeueOrEmptyAsync } from "./work-queue-shared.ts";

const EMPTY = { items: [], readId: undefined };
const PARAMETERS = {
	count: 10,
	invisibilityWindow: 30,
	queueId: "test-queue",
	universeId: "123",
};

async function dequeueAsync(http: FakeHttpClient): ReturnType<typeof dequeueOrEmptyAsync> {
	return dequeueOrEmptyAsync(createWorkQueueStorage({ apiKey: "test-key", httpClient: http }), {
		...PARAMETERS,
	});
}

describe(dequeueOrEmptyAsync, () => {
	it("should read the API's empty read as an empty success", async () => {
		expect.assertions(1);

		const http = createFakeHttpClient();
		// The 404 `items:read` answers when no item is visible, and the one a
		// queue that was never created answers — byte-identical, and to a
		// caller the same thing.
		http.mockApiError({
			code: "NOT_FOUND",
			message: "HTTP 404: Queue items not found.",
			statusCode: 404,
		});

		const read = await dequeueAsync(http);

		assert(read.success);

		expect(read.data).toStrictEqual(EMPTY);
	});

	it("should keep a 404 that carries no canonical status a failure", async () => {
		expect.assertions(1);

		const http = createFakeHttpClient();
		// What a moved or retired route answers: the legacy
		// `{"errors":[{"code":0}]}` envelope. Swallowing this one would report
		// an empty queue forever, silently.
		http.mockApiError({ code: "0", message: "HTTP 404:  (code 0)", statusCode: 404 });

		const read = await dequeueAsync(http);

		assert(!read.success);

		expect(read.err.message).toContain("HTTP 404");
	});

	it("should pass a non-404 failure straight through", async () => {
		expect.assertions(1);

		const http = createFakeHttpClient();
		http.mockApiError({ message: "Forbidden", statusCode: 403 });

		const read = await dequeueAsync(http);

		assert(!read.success);

		expect(read.err.message).toContain("Forbidden");
	});

	it("should report a 200 carrying no item as the same empty read", async () => {
		expect.assertions(1);

		const http = createFakeHttpClient();
		http.mockResponse({
			body: validDequeueBody({ id: "read-empty", queueItems: [] }),
			status: 200,
		});

		const read = await dequeueAsync(http);

		assert(read.success);

		expect(read.data).toStrictEqual(EMPTY);
	});

	it("should refuse an all-or-nothing read, whose 404 does not mean empty", async () => {
		expect.assertions(1);

		const http = createFakeHttpClient();
		http.mockResponse({ body: validDequeueBody({ queueItems: [] }), status: 200 });
		const storage = createWorkQueueStorage({ apiKey: "test-key", httpClient: http });

		const read = await dequeueOrEmptyAsync(storage, {
			...PARAMETERS,
			// @ts-expect-error -- the flag turns a 404 into "fewer than count
			// available", which this helper would misread as an empty queue.
			// Typecheck fails here the day that guard is dropped.
			allOrNothing: true,
		});

		assert(read.success);

		expect(read.data).toStrictEqual(EMPTY);
	});

	it("should carry the items and their readId through on a non-empty read", async () => {
		expect.assertions(2);

		const http = createFakeHttpClient();
		http.mockResponse({
			body: validDequeueBody({ id: "read-1", queueItems: [validQueueItemBody()] }),
			status: 200,
		});

		const read = await dequeueAsync(http);

		assert(read.success);

		expect(read.data.readId).toBe("read-1");
		expect(read.data.items).toHaveLength(1);
	});
});
