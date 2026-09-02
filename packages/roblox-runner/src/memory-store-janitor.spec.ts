import {
	createFakeHttpClient,
	createFakeSleep,
	type FakeHttpClient,
	type FakeSleep,
	validDequeueBody,
	validQueueItemBody,
} from "@bedrock-rbx/ocale/testing";

import { describe, expect, it, vi } from "vitest";

import { createMemoryStoreJanitor, type MemoryStoreJanitor } from "./memory-store-janitor.ts";

interface SortedMapItemBody {
	id: string;
	etag: string;
	expireTime: string;
	path: string;
	value: unknown;
}

function makeJanitor(
	httpClient: FakeHttpClient,
	overrides: {
		claimWindowSeconds?: number;
		log?: (message: string) => void;
		reclaimBudgetSeconds?: number;
		sleep?: FakeSleep;
	} = {},
): MemoryStoreJanitor {
	return createMemoryStoreJanitor({
		apiKey: "test-key",
		claimWindowSeconds: 45,
		httpClient,
		mapId: "run-a-progress",
		queueId: "run-a-queue",
		reclaimBudgetSeconds: 60,
		...overrides,
		universeId: "123",
	});
}

function validProgressItemBody(id: string): SortedMapItemBody {
	return {
		id,
		etag: "etag-1",
		expireTime: "2026-06-21T15:08:58.4806559Z",
		path: `cloud/v2/universes/123/memory-store/sorted-maps/run-a-progress/items/${id}`,
		value: { tested: 1 },
	};
}

function mockLeftoverSweep(http: FakeHttpClient, readId: string): void {
	http.mockResponse({
		body: validDequeueBody({ id: readId, queueItems: [validQueueItemBody()] }),
		status: 200,
	});
	http.mockResponse({ body: {}, status: 200 });
}

function mockEmptyQueue(http: FakeHttpClient): void {
	http.mockResponse({ body: validDequeueBody({ queueItems: [] }), status: 200 });
}

function mockEmptyProgress(http: FakeHttpClient): void {
	http.mockResponse({ body: { items: [] }, status: 200 });
}

describe("memory store janitor", () => {
	describe("queue drain", () => {
		it("should sweep dequeue→discard until an empty read", async () => {
			expect.assertions(4);

			const http = createFakeHttpClient();
			mockLeftoverSweep(http, "read-1");
			mockLeftoverSweep(http, "read-2");
			mockEmptyQueue(http);
			mockEmptyProgress(http);

			await makeJanitor(http).cleanupAsync();

			expect(http.requests).toHaveLength(6);
			expect(http.requests[1]!.request.url).toContain("/items:discard");
			expect(http.requests[1]!.request.body).toStrictEqual({ readId: "read-1" });
			expect(http.requests[3]!.request.body).toStrictEqual({ readId: "read-2" });
		});

		it("should claim with a short invisibility window so a failed sweep re-exposes items fast", async () => {
			expect.assertions(2);

			const http = createFakeHttpClient();
			mockEmptyQueue(http);
			mockEmptyProgress(http);

			await makeJanitor(http).cleanupAsync();

			expect(http.requests[0]!.request.url).toContain("count=100");
			expect(http.requests[0]!.request.url).toContain("invisibilityWindow=1s");
		});

		it("should be a no-op after a clean drain (one empty read, zero discards)", async () => {
			expect.assertions(2);

			const http = createFakeHttpClient();
			mockEmptyQueue(http);
			mockEmptyProgress(http);

			await makeJanitor(http).cleanupAsync();

			expect(http.requests).toHaveLength(2);
			expect(
				http.requests.some(({ request }) => request.url.includes(":discard")),
			).toBeFalse();
		});

		it("should touch only its own queue and map, and never the universe flush endpoint", async () => {
			expect.assertions(3);

			const http = createFakeHttpClient();
			mockLeftoverSweep(http, "read-1");
			mockEmptyQueue(http);
			http.mockResponse({
				body: { items: [validProgressItemBody("task-a")] },
				status: 200,
			});
			http.mockResponse({ body: {}, status: 200 });

			await makeJanitor(http).cleanupAsync();

			const urls = http.requests.map(({ request }) => request.url);

			expect(urls).toHaveLength(5);
			expect(urls).toSatisfyAll((url: string) => {
				return /\/memory-store\/(?:queues\/run-a-queue|sorted-maps\/run-a-progress)\//.test(
					url,
				);
			});
			expect(urls).toSatisfyAll((url: string) => !url.includes("memory-store:flush"));
		});

		it("should log and bail the drain on a dequeue failure, but still clean progress keys", async () => {
			expect.assertions(3);

			const http = createFakeHttpClient();
			http.mockApiError({ message: "Forbidden", statusCode: 403 });
			mockEmptyProgress(http);
			const log = vi.fn<(message: string) => void>();

			await makeJanitor(http, { log }).cleanupAsync();

			expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Forbidden"));
			expect(http.requests).toHaveLength(2);
			expect(http.requests[1]!.request.url).toContain(
				"/memory-store/sorted-maps/run-a-progress/",
			);
		});

		it("should log and bail the drain on a discard failure, but still clean progress keys", async () => {
			expect.assertions(3);

			const http = createFakeHttpClient();
			http.mockResponse({
				body: validDequeueBody({ id: "read-1", queueItems: [validQueueItemBody()] }),
				status: 200,
			});
			http.mockApiError({ message: "Forbidden", statusCode: 403 });
			mockEmptyProgress(http);
			const log = vi.fn<(message: string) => void>();

			await makeJanitor(http, { log }).cleanupAsync();

			expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Forbidden"));
			expect(http.requests).toHaveLength(3);
			expect(http.requests[2]!.request.url).toContain(
				"/memory-store/sorted-maps/run-a-progress/",
			);
		});

		it("should stop at the sweep cap when the queue never reads empty", async () => {
			expect.assertions(2);

			const http = createFakeHttpClient();
			for (let sweep = 0; sweep < 60; sweep += 1) {
				mockLeftoverSweep(http, `read-${sweep}`);
			}

			const log = vi.fn<(message: string) => void>();

			await makeJanitor(http, { log }).cleanupAsync();

			// 50 sweeps × (dequeue + discard), then one progress-list request.
			expect(http.requests).toHaveLength(101);
			expect(log).toHaveBeenCalledWith(expect.stringContaining("sweep cap"));
		});
	});

	describe("progress keys", () => {
		it("should delete every key across list pages", async () => {
			expect.assertions(4);

			const http = createFakeHttpClient();
			mockEmptyQueue(http);
			http.mockResponse({
				body: { items: [validProgressItemBody("task-a")], nextPageToken: "page-2" },
				status: 200,
			});
			http.mockResponse({
				body: { items: [validProgressItemBody("task-b")] },
				status: 200,
			});
			http.mockResponse({ body: {}, status: 200 });
			http.mockResponse({ body: {}, status: 200 });

			await makeJanitor(http).cleanupAsync();

			expect(http.requests).toHaveLength(5);
			expect(http.requests[2]!.request.url).toContain("pageToken=page-2");
			expect(http.requests[3]!.request.url).toContain(
				"/sorted-maps/run-a-progress/items/task-a",
			);
			expect(http.requests[4]!.request.url).toContain(
				"/sorted-maps/run-a-progress/items/task-b",
			);
		});

		it("should log a failed delete and continue with the remaining keys", async () => {
			expect.assertions(3);

			const http = createFakeHttpClient();
			mockEmptyQueue(http);
			http.mockResponse({
				body: {
					items: [validProgressItemBody("task-a"), validProgressItemBody("task-b")],
				},
				status: 200,
			});
			http.mockApiError({ message: "Forbidden", statusCode: 403 });
			http.mockResponse({ body: {}, status: 200 });
			const log = vi.fn<(message: string) => void>();

			await makeJanitor(http, { log }).cleanupAsync();

			expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Forbidden"));
			expect(http.requests).toHaveLength(4);
			expect(http.requests[3]!.request.url).toContain(
				"/sorted-maps/run-a-progress/items/task-b",
			);
		});
	});

	describe("reclaim pass", () => {
		it("should outwait the claim window, then sweep the items it hid", async () => {
			expect.assertions(3);

			const http = createFakeHttpClient();
			mockLeftoverSweep(http, "read-late");
			mockEmptyQueue(http);
			mockEmptyProgress(http);
			const sleep = createFakeSleep();

			await makeJanitor(http, { sleep }).reclaimClaimedAsync();

			expect(sleep.waits).toStrictEqual([45_000]);
			expect(http.requests).toHaveLength(4);
			expect(http.requests[1]!.request.body).toStrictEqual({ readId: "read-late" });
		});

		it("should delete the progress keys a starved task rewrote during the wait", async () => {
			expect.assertions(2);

			const http = createFakeHttpClient();
			mockEmptyQueue(http);
			http.mockResponse({ body: { items: [validProgressItemBody("task-a")] }, status: 200 });
			http.mockResponse({ body: {}, status: 200 });
			const sleep = createFakeSleep();

			await makeJanitor(http, { sleep }).reclaimClaimedAsync();

			expect(http.requests).toHaveLength(3);
			expect(http.requests[2]!.request.url).toContain(
				"/sorted-maps/run-a-progress/items/task-a",
			);
		});

		it("should cap the wait at the caller's reclaim budget and record the shortfall", async () => {
			expect.assertions(2);

			const http = createFakeHttpClient();
			mockEmptyQueue(http);
			mockEmptyProgress(http);
			const log = vi.fn<(message: string) => void>();
			const sleep = createFakeSleep();

			await makeJanitor(http, {
				claimWindowSeconds: 300,
				log,
				sleep,
			}).reclaimClaimedAsync();

			expect(sleep.waits).toStrictEqual([60_000]);
			expect(log).toHaveBeenCalledExactlyOnceWith(
				expect.stringContaining("waiting 60s of the 300s claim window"),
			);
		});

		it("should leave a clean cleanup with no wait at all", async () => {
			expect.assertions(2);

			const http = createFakeHttpClient();
			mockEmptyQueue(http);
			mockEmptyProgress(http);
			const sleep = createFakeSleep();

			await makeJanitor(http, { sleep }).cleanupAsync();

			expect(sleep.waits).toBeEmpty();
			expect(http.requests).toHaveLength(2);
		});
	});

	describe("best effort", () => {
		it("should resolve (never reject) when every call fails", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockApiError({ message: "Down", statusCode: 403 });
			http.mockApiError({ message: "Down", statusCode: 403 });
			const log = vi.fn<(message: string) => void>();

			await makeJanitor(http, { log }).cleanupAsync();

			expect(log).toHaveBeenCalledTimes(2);
		});

		it("should default the wait seam to a real timer", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			mockEmptyQueue(http);
			mockEmptyProgress(http);

			// A sub-millisecond window keeps the real timer this proves is
			// installed from costing the suite anything.
			await expect(
				makeJanitor(http, { claimWindowSeconds: 0.001 }).reclaimClaimedAsync(),
			).resolves.toBeUndefined();
		});

		it("should default the log seam to a no-op", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockApiError({ message: "Down", statusCode: 403 });
			http.mockApiError({ message: "Down", statusCode: 403 });

			await expect(makeJanitor(http).cleanupAsync()).resolves.toBeUndefined();
		});
	});
});
