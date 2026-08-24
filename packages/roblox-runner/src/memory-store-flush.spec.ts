import { createFakeHttpClient } from "@bedrock-rbx/ocale/testing";
import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it, vi } from "vitest";

import { flushMemoryStoreAsync } from "./memory-store-flush.ts";

describe("memory store flush", () => {
	it("should POST the universe-wide flush endpoint", async () => {
		expect.assertions(3);

		const http = createFakeHttpClient();
		http.mockResponse({ body: {}, status: 200 });

		await flushMemoryStoreAsync({ apiKey: "test-key", httpClient: http, universeId: "123" });

		expect(http.requests).toHaveLength(1);
		expect(http.requests[0]!.request.method).toBe("POST");
		expect(http.requests[0]!.request.url).toContain(
			"/cloud/v2/universes/123/memory-store:flush",
		);
	});

	it("should route through a custom baseUrl when supplied", async () => {
		expect.assertions(1);

		const http = createFakeHttpClient();
		http.mockResponse({ body: {}, status: 200 });

		await flushMemoryStoreAsync({
			apiKey: "test-key",
			baseUrl: "http://127.0.0.1:4010",
			httpClient: http,
			universeId: "123",
		});

		expect(http.requests[0]!.config.baseUrl).toBe("http://127.0.0.1:4010");
	});

	it("should throw when the flush returns an API error", async () => {
		expect.assertions(1);

		const http = createFakeHttpClient();
		http.mockApiError({ message: "Forbidden", statusCode: 403 });

		await expect(
			flushMemoryStoreAsync({ apiKey: "test-key", httpClient: http, universeId: "123" }),
		).rejects.toThrow(/Forbidden/);
	});

	describe("default fetch transport", () => {
		it("should send the full URL with the api key header", async () => {
			expect.assertions(3);

			const fetchMock = vi
				.fn<typeof fetch>()
				.mockResolvedValue(fromAny(new Response("{}", { status: 200 })));
			vi.stubGlobal("fetch", fetchMock);

			await flushMemoryStoreAsync({ apiKey: "test-key", universeId: "123" });

			const [url, init] = fetchMock.mock.calls[0]!;

			expect(url).toBe("https://apis.roblox.com/cloud/v2/universes/123/memory-store:flush");
			expect(init).toMatchObject({ method: "POST" });
			expect(init!.headers).toMatchObject({ "x-api-key": "test-key" });
		});

		it("should throw on a non-2xx response", async () => {
			expect.assertions(1);

			const fetchMock = vi
				.fn<typeof fetch>()
				.mockResolvedValue(fromAny(new Response("quota", { status: 429 })));
			vi.stubGlobal("fetch", fetchMock);

			await expect(
				flushMemoryStoreAsync({ apiKey: "test-key", universeId: "123" }),
			).rejects.toThrow(/429/);
		});

		it("should surface a network failure as a thrown error", async () => {
			expect.assertions(1);

			const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("socket hang up"));
			vi.stubGlobal("fetch", fetchMock);

			await expect(
				flushMemoryStoreAsync({ apiKey: "test-key", universeId: "123" }),
			).rejects.toThrow(/socket hang up/);
		});

		it("should stringify a non-Error rejection", async () => {
			expect.assertions(1);

			const fetchMock = vi.fn<typeof fetch>().mockRejectedValue("wire torn");
			vi.stubGlobal("fetch", fetchMock);

			await expect(
				flushMemoryStoreAsync({ apiKey: "test-key", universeId: "123" }),
			).rejects.toThrow(/wire torn/);
		});
	});
});
