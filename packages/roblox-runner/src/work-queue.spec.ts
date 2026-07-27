import { createFakeHttpClient, type FakeHttpClient } from "@bedrock-rbx/ocale/testing";
import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it } from "vitest";

import { WorkQueue } from "./work-queue.ts";

interface Job {
	name: string;
	priority: number;
}

function makeQueue(
	httpClient: FakeHttpClient,
	overrides: { decode?: (value: unknown) => Job; encode?: (job: Job) => unknown } = {},
): WorkQueue<Job> {
	return new WorkQueue<Job>({
		apiKey: "test-key",
		decode: overrides.decode ?? ((value) => fromAny(value)),
		encode: overrides.encode ?? ((job) => job),
		httpClient,
		queueId: "test-queue",
		universeId: "123",
	});
}

function validQueueItemBody(data: unknown): Record<string, unknown> {
	return {
		data,
		expireTime: "2026-06-21T15:08:58.4806559Z",
		path: "cloud/v2/universes/123/memory-store/queues/test-queue/items/item-1",
		priority: 1,
	};
}

describe(WorkQueue, () => {
	describe("enqueue", () => {
		it("should POST one item per call", async () => {
			expect.assertions(2);

			const http = createFakeHttpClient();
			http.mockResponse({
				body: validQueueItemBody({ name: "a", priority: 1 }),
				status: 200,
			});
			http.mockResponse({
				body: validQueueItemBody({ name: "b", priority: 2 }),
				status: 200,
			});

			const queue = makeQueue(http);
			await queue.enqueueAsync([
				{ name: "a", priority: 1 },
				{ name: "b", priority: 2 },
			]);

			expect(http.requests).toHaveLength(2);
			expect(http.requests[0]!.request.url).toContain(
				"/universes/123/memory-store/queues/test-queue/items",
			);
		});

		it("should pass encoded payload to enqueue body", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockResponse({ body: validQueueItemBody({ packed: "job:a" }), status: 200 });

			const queue = makeQueue(http, {
				encode: (job) => ({ packed: `job:${job.name}` }),
			});
			await queue.enqueueAsync([{ name: "a", priority: 0 }]);

			expect(http.requests[0]!.request.body).toStrictEqual({
				data: { packed: "job:a" },
			});
		});

		it("should encode ttlMs as seconds via 'Ns' duration string", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockResponse({
				body: validQueueItemBody({ name: "a", priority: 0 }),
				status: 200,
			});

			const queue = makeQueue(http);
			await queue.enqueueAsync([{ name: "a", priority: 0 }], { ttlMs: 30_000 });

			expect(http.requests[0]!.request.body).toHaveProperty("ttl", "30s");
		});

		it("should round sub-second ttlMs up to 1 second", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockResponse({
				body: validQueueItemBody({ name: "a", priority: 0 }),
				status: 200,
			});

			const queue = makeQueue(http);
			await queue.enqueueAsync([{ name: "a", priority: 0 }], { ttlMs: 500 });

			expect(http.requests[0]!.request.body).toHaveProperty("ttl", "1s");
		});

		it("should omit ttl when ttlMs not provided", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockResponse({
				body: validQueueItemBody({ name: "a", priority: 0 }),
				status: 200,
			});

			const queue = makeQueue(http);
			await queue.enqueueAsync([{ name: "a", priority: 0 }]);

			expect(http.requests[0]!.request.body).not.toHaveProperty("ttl");
		});

		it("should throw when encode returns null", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			const queue = makeQueue(http, { encode: () => null });

			await expect(queue.enqueueAsync([{ name: "a", priority: 0 }])).rejects.toThrow(
				/null\/undefined/,
			);
		});

		it("should throw when encode returns undefined", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			// `() => {}` is a block body that returns undefined; not `() =>
			// ({})`.
			const queue = makeQueue(http, { encode: () => {} });

			await expect(queue.enqueueAsync([{ name: "a", priority: 0 }])).rejects.toThrow(
				/null\/undefined/,
			);
		});

		it("should throw when enqueue returns API error", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockApiError({ message: "Server unavailable", statusCode: 503 });

			const queue = makeQueue(http);

			await expect(queue.enqueueAsync([{ name: "a", priority: 0 }])).rejects.toThrow(
				/Server unavailable/,
			);
		});
	});

	describe("claim + commit", () => {
		it("should dequeue and return decoded items + commit handle", async () => {
			expect.assertions(3);

			const http = createFakeHttpClient();
			http.mockResponse({
				body: {
					id: "read-1",
					queueItems: [
						validQueueItemBody({ name: "a", priority: 1 }),
						validQueueItemBody({ name: "b", priority: 2 }),
					],
				},
				status: 200,
			});

			const queue = makeQueue(http);
			const batch = await queue.claimAsync(2, 30_000);

			expect(batch.items).toStrictEqual([
				{ name: "a", priority: 1 },
				{ name: "b", priority: 2 },
			]);

			const captured = http.requests[0]!.request;

			expect(captured.url).toContain("count=2");
			expect(captured.url).toContain("invisibilityWindow=30s");
		});

		it("should call decode for each dequeued item", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockResponse({
				body: { id: "read-1", queueItems: [validQueueItemBody("job:a")] },
				status: 200,
			});

			const queue = makeQueue(http, {
				decode: (value) => ({ name: String(value).replace("job:", ""), priority: 7 }),
			});
			const batch = await queue.claimAsync(1, 30_000);

			expect(batch.items).toStrictEqual([{ name: "a", priority: 7 }]);
		});

		it("should POST discard with readId on commit", async () => {
			expect.assertions(2);

			const http = createFakeHttpClient();
			http.mockResponse({
				body: {
					id: "read-xyz",
					queueItems: [validQueueItemBody({ name: "a", priority: 1 })],
				},
				status: 200,
			});
			http.mockResponse({ body: {}, status: 200 });

			const queue = makeQueue(http);
			const batch = await queue.claimAsync(1, 30_000);
			await batch.commit();

			const discardRequest = http.requests[1]!.request;

			expect(discardRequest.url).toContain("/items:discard");
			expect(discardRequest.body).toStrictEqual({ readId: "read-xyz" });
		});

		it("should round sub-second invisibilityMs up to 1 second", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockResponse({
				body: { id: "read-1", queueItems: [] },
				status: 200,
			});

			const queue = makeQueue(http);
			await queue.claimAsync(1, 250);

			const captured = http.requests[0]!.request;

			expect(captured.url).toContain("invisibilityWindow=1s");
		});

		it("should throw when claim returns API error", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockApiError({ message: "Forbidden", statusCode: 403 });

			const queue = makeQueue(http);

			await expect(queue.claimAsync(1, 30_000)).rejects.toThrow(/Forbidden/);
		});

		it("should throw when commit (discard) returns API error", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockResponse({
				body: {
					id: "read-1",
					queueItems: [validQueueItemBody({ name: "a", priority: 1 })],
				},
				status: 200,
			});
			http.mockApiError({ message: "Conflict", statusCode: 409 });

			const queue = makeQueue(http);
			const batch = await queue.claimAsync(1, 30_000);

			await expect(batch.commit()).rejects.toThrow(/Conflict/);
		});
	});

	describe("construction", () => {
		it("should construct with default http client when none provided", () => {
			expect.assertions(1);

			const queue = new WorkQueue<Job>({
				apiKey: "test-key",
				decode: (value) => fromAny(value),
				encode: (job) => job,
				queueId: "test-queue",
				universeId: "123",
			});

			expect(queue).toBeInstanceOf(WorkQueue);
		});

		it("should accept an injected sleep function", () => {
			expect.assertions(1);

			async function sleepAsync(): Promise<void> {}

			const queue = new WorkQueue<Job>({
				apiKey: "test-key",
				decode: (value) => fromAny(value),
				encode: (job) => job,
				queueId: "test-queue",
				sleep: sleepAsync,
				universeId: "123",
			});

			expect(queue).toBeInstanceOf(WorkQueue);
		});

		it("should route enqueue traffic through a custom baseUrl when supplied", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockResponse({
				body: validQueueItemBody({ name: "a", priority: 1 }),
				status: 200,
			});

			const queue = new WorkQueue<Job>({
				apiKey: "test-key",
				baseUrl: "http://127.0.0.1:4010",
				decode: (value) => fromAny(value),
				encode: (job) => job,
				httpClient: http,
				queueId: "test-queue",
				universeId: "123",
			});
			await queue.enqueueAsync([{ name: "a", priority: 1 }]);

			expect(http.requests[0]!.config.baseUrl).toBe("http://127.0.0.1:4010");
		});
	});
});
