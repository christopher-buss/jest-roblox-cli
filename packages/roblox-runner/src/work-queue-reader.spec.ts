import {
	createFakeHttpClient,
	type FakeHttpClient,
	validDequeueBody,
	validQueueItemBody,
} from "@bedrock-rbx/ocale/testing";
import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it } from "vitest";

import { createWorkQueueReader, type WorkQueueReader } from "./work-queue-reader.ts";

interface Job {
	name: string;
	priority: number;
}

function makeReader(
	httpClient: FakeHttpClient,
	overrides: { decode?: (value: unknown) => Job } = {},
): WorkQueueReader<Job> {
	return createWorkQueueReader<Job>({
		apiKey: "test-key",
		decode: overrides.decode ?? ((value) => fromAny(value)),
		httpClient,
		queueId: "test-queue",
		universeId: "123",
	});
}

describe("work queue reader", () => {
	describe("claim + commit", () => {
		it("should dequeue and return decoded items + commit handle", async () => {
			expect.assertions(3);

			const http = createFakeHttpClient();
			http.mockResponse({
				body: {
					id: "read-1",
					queueItems: [
						validQueueItemBody({ data: { name: "a", priority: 1 } }),
						validQueueItemBody({ data: { name: "b", priority: 2 } }),
					],
				},
				status: 200,
			});

			const queue = makeReader(http);
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
				body: { id: "read-1", queueItems: [validQueueItemBody({ data: "job:a" })] },
				status: 200,
			});

			const queue = makeReader(http, {
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
					queueItems: [validQueueItemBody({ data: { name: "a", priority: 1 } })],
				},
				status: 200,
			});
			http.mockResponse({ body: {}, status: 200 });

			const queue = makeReader(http);
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

			const queue = makeReader(http);
			await queue.claimAsync(1, 250);

			const captured = http.requests[0]!.request;

			expect(captured.url).toContain("invisibilityWindow=1s");
		});

		it("should hand back an empty batch, with nothing to discard, on an empty read", async () => {
			expect.assertions(2);

			const http = createFakeHttpClient();
			http.mockResponse({
				body: validDequeueBody({ id: "read-empty", queueItems: [] }),
				status: 200,
			});

			const queue = makeReader(http);
			const batch = await queue.claimAsync(1, 30_000);
			await batch.commit();

			expect(batch.items).toBeEmpty();
			expect(http.requests).toHaveLength(1);
		});

		it("should throw when claim returns API error", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockApiError({ message: "Forbidden", statusCode: 403 });

			const queue = makeReader(http);

			await expect(queue.claimAsync(1, 30_000)).rejects.toThrow(/Forbidden/);
		});

		it("should throw when commit (discard) returns API error", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockResponse({
				body: {
					id: "read-1",
					queueItems: [validQueueItemBody({ data: { name: "a", priority: 1 } })],
				},
				status: 200,
			});
			http.mockApiError({ message: "Conflict", statusCode: 409 });

			const queue = makeReader(http);
			const batch = await queue.claimAsync(1, 30_000);

			await expect(batch.commit()).rejects.toThrow(/Conflict/);
		});
	});
});

describe("reader construction", () => {
	it("should claim without configuring an encoder", async () => {
		expect.assertions(1);

		const http = createFakeHttpClient();
		http.mockResponse({
			body: {
				id: "read-1",
				queueItems: [validQueueItemBody({ data: { name: "a", priority: 1 } })],
			},
			status: 200,
		});

		const queue = createWorkQueueReader<Job>({
			apiKey: "test-key",
			decode: (value) => fromAny(value),
			httpClient: http,
			queueId: "test-queue",
			universeId: "123",
		});
		const batch = await queue.claimAsync(1, 30_000);

		expect(batch.items).toStrictEqual([{ name: "a", priority: 1 }]);
	});

	it("should accept an injected sleep function", () => {
		expect.assertions(1);

		async function sleepAsync(): Promise<void> {}

		const queue = createWorkQueueReader<Job>({
			apiKey: "test-key",
			decode: (value) => fromAny(value),
			queueId: "test-queue",
			sleep: sleepAsync,
			universeId: "123",
		});

		expect(queue.claimAsync).toBeTypeOf("function");
	});
});
