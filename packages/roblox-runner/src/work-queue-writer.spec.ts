import {
	createFakeHttpClient,
	type FakeHttpClient,
	validQueueItemBody,
} from "@bedrock-rbx/ocale/testing";

import { describe, expect, it } from "vitest";

import {
	createJsonWorkQueueWriter,
	createWorkQueueHost,
	createWorkQueueWriter,
	type WorkQueueWriter,
	type WorkQueueWriterOptions,
} from "./work-queue-writer.ts";

interface Job {
	name: string;
	priority: number;
}

function makeWriter(
	httpClient: FakeHttpClient,
	overrides: { encode?: WorkQueueWriterOptions<Job>["encode"] } = {},
): WorkQueueWriter<Job> {
	return createWorkQueueWriter<Job>({
		apiKey: "test-key",

		encode: overrides.encode ?? ((job) => ({ ...job })),
		httpClient,
		queueId: "test-queue",
		universeId: "123",
	});
}

describe("work queue writer", () => {
	it("should let a host acknowledge an opaque worker receipt", async () => {
		expect.assertions(2);

		const http = createFakeHttpClient();
		http.mockResponse({ body: {}, status: 200 });
		const queue = createWorkQueueHost<Job>({
			apiKey: "test-key",
			encode: (job) => ({ ...job }),
			httpClient: http,
			queueId: "test-queue",
			universeId: "123",
		});

		await queue.acknowledgeAsync("read-worker-1");

		expect(http.requests[0]!.request.url).toContain("/items:discard");
		expect(http.requests[0]!.request.body).toStrictEqual({ readId: "read-worker-1" });
	});

	it("should surface a rejected host acknowledgement", async () => {
		expect.assertions(1);

		const http = createFakeHttpClient();
		http.mockApiError({ message: "receipt expired", statusCode: 409 });
		const queue = createWorkQueueHost<Job>({
			apiKey: "test-key",
			encode: (job) => ({ ...job }),
			httpClient: http,
			queueId: "test-queue",
			universeId: "123",
		});

		await expect(queue.acknowledgeAsync("read-worker-1")).rejects.toThrow(/receipt expired/);
	});

	describe("enqueue", () => {
		it("should POST one item per call", async () => {
			expect.assertions(2);

			const http = createFakeHttpClient();
			http.mockResponse({
				body: validQueueItemBody({ data: { name: "a", priority: 1 } }),
				status: 200,
			});
			http.mockResponse({
				body: validQueueItemBody({ data: { name: "b", priority: 2 } }),
				status: 200,
			});

			const queue = makeWriter(http);
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
			http.mockResponse({
				body: validQueueItemBody({ data: { packed: "job:a" } }),
				status: 200,
			});

			const queue = makeWriter(http, {
				encode: (job) => ({ packed: `job:${job.name}` }),
			});
			await queue.enqueueAsync([{ name: "a", priority: 0 }]);

			expect(http.requests[0]!.request.body).toStrictEqual({
				data: { packed: "job:a" },
			});
		});

		it.for([
			{ ttl: "30s", ttlMs: 30_000 },
			{ ttl: "1s", ttlMs: 500 },
		])("should round $ttlMs milliseconds up to $ttl", async ({ ttl, ttlMs }) => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockResponse({
				body: validQueueItemBody({ data: { name: "a", priority: 0 } }),
				status: 200,
			});
			await makeWriter(http).enqueueAsync([{ name: "a", priority: 0 }], { ttlMs });

			expect(http.requests[0]!.request.body).toHaveProperty("ttl", ttl);
		});

		it("should omit ttl when ttlMs not provided", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockResponse({
				body: validQueueItemBody({ data: { name: "a", priority: 0 } }),
				status: 200,
			});

			const queue = makeWriter(http);
			await queue.enqueueAsync([{ name: "a", priority: 0 }]);

			expect(http.requests[0]!.request.body).not.toHaveProperty("ttl");
		});

		it("should throw when enqueue returns API error", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockApiError({ message: "Server unavailable", statusCode: 503 });

			const queue = makeWriter(http);

			await expect(queue.enqueueAsync([{ name: "a", priority: 0 }])).rejects.toThrow(
				/Server unavailable/,
			);
		});
	});

	describe("construction", () => {
		it("should enqueue without configuring a decoder", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockResponse({
				body: validQueueItemBody({ data: { name: "a", priority: 1 } }),
				status: 200,
			});

			const queue = createJsonWorkQueueWriter<Job>({
				apiKey: "test-key",
				httpClient: http,
				queueId: "test-queue",
				universeId: "123",
			});
			await queue.enqueueAsync([{ name: "a", priority: 1 }]);

			expect(http.requests[0]!.request.body).toStrictEqual({
				data: { name: "a", priority: 1 },
			});
		});

		it("should construct with default http client when none provided", () => {
			expect.assertions(1);

			const queue = createWorkQueueWriter<Job>({
				apiKey: "test-key",
				encode: (job) => ({ ...job }),
				queueId: "test-queue",
				universeId: "123",
			});

			expect(queue.enqueueAsync).toBeTypeOf("function");
		});

		it("should route enqueue traffic through a custom baseUrl when supplied", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockResponse({
				body: validQueueItemBody({ data: { name: "a", priority: 1 } }),
				status: 200,
			});

			const queue = createWorkQueueWriter<Job>({
				apiKey: "test-key",
				baseUrl: "http://127.0.0.1:4010",
				encode: (job) => ({ ...job }),
				httpClient: http,
				queueId: "test-queue",
				universeId: "123",
			});
			await queue.enqueueAsync([{ name: "a", priority: 1 }]);

			expect(http.requests[0]!.config.baseUrl).toBe("http://127.0.0.1:4010");
		});
	});
});
