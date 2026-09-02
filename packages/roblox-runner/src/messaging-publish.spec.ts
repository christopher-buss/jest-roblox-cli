import type { FakeHttpClient } from "@bedrock-rbx/ocale/testing";
import { createFakeHttpClient } from "@bedrock-rbx/ocale/testing";
import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it, vi } from "vitest";

import { publishMessageAsync } from "./messaging-publish.ts";

async function publishAsync(http: FakeHttpClient, overrides?: { baseUrl?: string }): Promise<void> {
	await publishMessageAsync({
		apiKey: "test-key",
		httpClient: http,
		message: "cancel",
		topic: "run-1-cancel",
		universeId: "123",
		...overrides,
	});
}

describe("messaging publish", () => {
	it("should POST the topic and message to the universe publish endpoint", async () => {
		expect.assertions(4);

		const http = createFakeHttpClient();
		http.mockResponse({ body: {}, status: 200 });

		await publishAsync(http);

		expect(http.requests).toHaveLength(1);
		expect(http.requests[0]!.request.method).toBe("POST");
		expect(http.requests[0]!.request.url).toBe("/cloud/v2/universes/123:publishMessage");
		expect(http.requests[0]!.request.body).toStrictEqual({
			message: "cancel",
			topic: "run-1-cancel",
		});
	});

	it("should route through a custom baseUrl when supplied", async () => {
		expect.assertions(1);

		const http = createFakeHttpClient();
		http.mockResponse({ body: {}, status: 200 });

		await publishAsync(http, { baseUrl: "http://127.0.0.1:4010" });

		expect(http.requests[0]!.config.baseUrl).toBe("http://127.0.0.1:4010");
	});

	it("should default to the public Open Cloud host", async () => {
		expect.assertions(1);

		const http = createFakeHttpClient();
		http.mockResponse({ body: {}, status: 200 });

		await publishAsync(http);

		expect(http.requests[0]!.config.baseUrl).toBe("https://apis.roblox.com");
	});

	it("should throw when the publish returns an API error", async () => {
		expect.assertions(1);

		const http = createFakeHttpClient();
		http.mockApiError({ message: "Bad Request", statusCode: 400 });

		await expect(publishAsync(http)).rejects.toThrow(/Bad Request/);
	});

	it("should say nothing about scopes on a failure the key did not cause", async () => {
		expect.assertions(1);

		const http = createFakeHttpClient();
		http.mockApiError({ message: "Bad Request", statusCode: 400 });

		// A 400 is a malformed request, not a missing permission; naming the
		// scope here would send the reader to the wrong place.
		await expect(publishAsync(http)).rejects.not.toThrow(/universe-messaging-service/);
	});

	it.for([401, 403])(
		"should name the missing api-key scope when the publish is refused with %i",
		async (statusCode) => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockApiError({ message: "Refused", statusCode });

			await expect(publishAsync(http)).rejects.toThrow(/universe-messaging-service:publish/);
		},
	);

	it("should reach Open Cloud over the real transport when no client is injected", async () => {
		expect.assertions(1);

		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(fromAny(new Response("{}", { status: 200 })));
		vi.stubGlobal("fetch", fetchMock);

		await publishMessageAsync({
			apiKey: "test-key",
			message: "cancel",
			topic: "run-1-cancel",
			universeId: "123",
		});

		expect(fetchMock.mock.calls[0]![0]).toBe(
			"https://apis.roblox.com/cloud/v2/universes/123:publishMessage",
		);
	});

	it("should name no scope on a failure that carries no status at all", async () => {
		expect.assertions(2);

		const http = createFakeHttpClient();
		http.mockNetworkError({ message: "socket hang up" });

		// A dropped connection never reached the permission check, so the key is
		// not what the reader should go and look at.
		await expect(publishAsync(http)).rejects.toThrow(/socket hang up/);
		await expect(publishAsync(http)).rejects.not.toThrow(/universe-messaging-service/);
	});
});
