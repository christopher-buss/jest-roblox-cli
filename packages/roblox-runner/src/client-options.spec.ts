import { createFakeHttpClient } from "@bedrock-rbx/ocale/testing";

import { describe, expect, it, vi } from "vitest";

import {
	createClientOptions,
	createStorageClient,
	createSubmitRequestOptions,
} from "./client-options.ts";

describe(createClientOptions, () => {
	it("should bind the authorized key and configured SDK overrides", () => {
		expect.assertions(1);

		const httpClient = createFakeHttpClient();
		const sleep = vi.fn<(ms: number) => Promise<void>>();

		expect(
			createClientOptions("key", {
				baseUrl: "http://localhost",
				httpClient,
				maxRetries: 0,
				sleep,
			}),
		).toStrictEqual({
			apiKey: "key",
			baseUrl: "http://localhost",
			httpClient,
			maxRetries: 0,
			sleep,
		});
	});

	it("should omit absent overrides while supplying the native transport", () => {
		expect.assertions(2);

		const options = createClientOptions("key", undefined);

		expect(Object.keys(options).sort()).toStrictEqual(["apiKey", "httpClient"]);
		expect(options.httpClient.request).toBeTypeOf("function");
	});

	it("should preserve the default retry policy with an injected transport", () => {
		expect.assertions(1);

		const httpClient = createFakeHttpClient();

		expect(createClientOptions("other", { httpClient })).toStrictEqual({
			apiKey: "other",
			httpClient,
		});
	});
});

describe(createStorageClient, () => {
	it("should issue storage calls through the injected SDK transport", async () => {
		expect.assertions(2);

		const http = createFakeHttpClient();
		http.mockResponse({ body: {}, status: 200 });
		const storage = createStorageClient({
			apiKey: "storage-key",
			baseUrl: "https://storage.example",
			httpClient: http,
		});
		await storage.queues.discard({ queueId: "queue", readId: "receipt", universeId: "123" });

		expect(http.requests[0]!.request.url).toBe(
			"/cloud/v2/universes/123/memory-store/queues/queue/items:discard",
		);
		expect(http.requests[0]!.config).toMatchObject({
			apiKey: "storage-key",
			baseUrl: "https://storage.example",
		});
	});
});

describe(createSubmitRequestOptions, () => {
	it("should preserve SDK retry counts and disable ambiguous transport retry when requested", () => {
		expect.assertions(1);

		const signal = AbortSignal.abort("stopped");

		expect(
			createSubmitRequestOptions({
				isSubmitIdempotent: false,
				retrySubmitTransportErrors: false,
				signal,
				submitBudget: undefined,
				timeout: 1234,
			}),
		).toStrictEqual({ retryableTransportCodes: [], signal, timeout: 1234 });
	});

	it("should bound explicitly budgeted idempotent create retries through SDK policy", () => {
		expect.assertions(4);

		const signal = AbortSignal.abort("stopped");
		const options = createSubmitRequestOptions({
			isSubmitIdempotent: true,
			retrySubmitTransportErrors: true,
			signal,
			submitBudget: 1000,
			timeout: 2345,
		});

		expect(options.maxRetries).toBe(32);
		expect(options.retryableStatuses).toStrictEqual([429, 500, 502, 503, 504]);
		expect(options.retryableTransportCodes).toContain("ECONNRESET");
		expect(options).toMatchObject({ signal, timeout: 2345 });
	});
});
