import buffer from "node:buffer";
import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";

import { createFetchClient } from "./http-client.ts";

function mockResponse(options: {
	body: JSONValue;
	contentType?: string;
	ok?: boolean;
	retryAfter?: string;
	status?: number;
}): Response {
	const headers = new Headers();
	if (options.contentType !== undefined) {
		headers.set("content-type", options.contentType);
	}

	if (options.retryAfter !== undefined) {
		headers.set("retry-after", options.retryAfter);
	}

	const bodyStr =
		typeof options.body === "string" ? options.body : JSON.stringify(options.body ?? {});

	return {
		headers,
		json: async () => options.body,
		ok: options.ok ?? true,
		status: options.status ?? 200,
		text: async () => bodyStr,
	} as unknown as Response;
}

function stubFetch(): Mock<typeof fetch> {
	vi.stubGlobal("fetch", vi.fn());

	return vi.mocked(fetch);
}

describe(createFetchClient, () => {
	it("should send a GET request with default headers", async () => {
		expect.assertions(4);

		const fetchMock = stubFetch();
		fetchMock.mockResolvedValue(
			mockResponse({ body: { ok: true }, contentType: "application/json" }),
		);

		const client = createFetchClient({ "x-api-key": "test-key" });
		const result = await client.request("GET", "https://example.com/api");

		expect(fetchMock).toHaveBeenCalledWith("https://example.com/api", {
			headers: { "x-api-key": "test-key" },
			method: "GET",
		});
		expect(result.body).toStrictEqual({ ok: true });
		expect(result.ok).toBe(true);
		expect(result.status).toBe(200);
	});

	it("should merge request headers with default headers", async () => {
		expect.assertions(1);

		const fetchMock = stubFetch();
		fetchMock.mockResolvedValue(mockResponse({ body: "ok", contentType: "text/plain" }));

		const client = createFetchClient({ "x-api-key": "key" });
		await client.request("GET", "https://example.com", {
			headers: { "x-custom": "value" },
		});

		expect(fetchMock).toHaveBeenCalledWith("https://example.com", {
			headers: { "x-api-key": "key", "x-custom": "value" },
			method: "GET",
		});
	});

	it("should JSON-stringify object bodies and set content-type", async () => {
		expect.assertions(2);

		const fetchMock = stubFetch();
		fetchMock.mockResolvedValue(mockResponse({ body: {}, contentType: "application/json" }));

		const client = createFetchClient();
		await client.request("POST", "https://example.com", {
			body: { data: "test" },
		});

		const callOptions = fetchMock.mock.calls[0]![1];

		expect(callOptions?.body).toBe('{"data":"test"}');
		expect(callOptions?.headers).toHaveProperty("Content-Type", "application/json");
	});

	it("should pass Buffer bodies directly without JSON serialization", async () => {
		expect.assertions(3);

		const fetchMock = stubFetch();
		fetchMock.mockResolvedValue(mockResponse({ body: "ok" }));

		const bodyBuffer = buffer.Buffer.from("binary data");
		const client = createFetchClient();
		await client.request("POST", "https://example.com", { body: bodyBuffer });

		const callOptions = fetchMock.mock.calls[0]![1]!;

		expect(callOptions).toBeDefined();
		expect(callOptions.body).toBe(bodyBuffer);
		expect(callOptions.headers).not.toHaveProperty("Content-Type");
	});

	it("should parse JSON responses when content-type is application/json", async () => {
		expect.assertions(1);

		const fetchMock = stubFetch();
		fetchMock.mockResolvedValue(
			mockResponse({
				body: { result: "data" },
				contentType: "application/json",
			}),
		);

		const client = createFetchClient();
		const result = await client.request("GET", "https://example.com");

		expect(result.body).toStrictEqual({ result: "data" });
	});

	it("should return text for non-JSON responses", async () => {
		expect.assertions(1);

		const fetchMock = stubFetch();
		fetchMock.mockResolvedValue(
			mockResponse({
				body: "plain text",
				contentType: "text/plain",
			}),
		);

		const client = createFetchClient();
		const result = await client.request("GET", "https://example.com");

		expect(result.body).toBe("plain text");
	});

	it("should extract retry-after header", async () => {
		expect.assertions(2);

		const fetchMock = stubFetch();
		fetchMock.mockResolvedValue(
			mockResponse({
				body: "",
				retryAfter: "30",
				status: 429,
			}),
		);

		const client = createFetchClient();
		const result = await client.request("GET", "https://example.com");

		expect(result.headers).toBeDefined();
		expect(result.headers!["retry-after"]).toBe("30");
	});

	it("should return undefined retry-after when header is absent", async () => {
		expect.assertions(2);

		const fetchMock = stubFetch();
		fetchMock.mockResolvedValue(mockResponse({ body: "" }));

		const client = createFetchClient();
		const result = await client.request("GET", "https://example.com");

		expect(result.headers).toBeDefined();
		expect(result.headers!["retry-after"]).toBeUndefined();
	});

	it("should propagate non-ok status", async () => {
		expect.assertions(2);

		const fetchMock = stubFetch();
		fetchMock.mockResolvedValue(
			mockResponse({
				body: "Not Found",
				contentType: "text/plain",
				ok: false,
				status: 404,
			}),
		);

		const client = createFetchClient();
		const result = await client.request("GET", "https://example.com");

		expect(result.ok).toBe(false);
		expect(result.status).toBe(404);
	});
});
