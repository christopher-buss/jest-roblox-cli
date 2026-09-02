import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it, vi } from "vitest";

import { createFetchHttpClient } from "./open-cloud-fetch.ts";

const CONFIG = { apiKey: "test-key", baseUrl: "https://apis.roblox.com" };

async function requestAsync(body?: { topic: string }) {
	return createFetchHttpClient().request(
		{ method: "POST", url: "/cloud/v2/universes/123:doThing", ...(body ? { body } : {}) },
		CONFIG,
	);
}

/** Stubs `fetch` with a 200 and hands back the mock the case asserts on. */
function stubOkFetch() {
	const fetchMock = vi
		.fn<typeof fetch>()
		.mockResolvedValue(fromAny(new Response("{}", { status: 200 })));
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

describe("open cloud fetch transport", () => {
	it("should send the full URL with the api key header", async () => {
		expect.assertions(3);

		const fetchMock = stubOkFetch();

		await requestAsync();
		const [url, init] = fetchMock.mock.calls[0]!;

		expect(url).toBe("https://apis.roblox.com/cloud/v2/universes/123:doThing");
		expect(init).toMatchObject({ method: "POST" });
		expect(init!.headers).toStrictEqual({ "x-api-key": "test-key" });
	});

	it("should send no body and declare no content type when the request carries none", async () => {
		expect.assertions(2);

		const fetchMock = stubOkFetch();

		await requestAsync();
		const [, init] = fetchMock.mock.calls[0]!;

		expect(init!.body).toBeUndefined();
		expect(init!.headers).not.toHaveProperty("content-type");
	});

	it("should send a JSON body under a JSON content type when the request carries one", async () => {
		expect.assertions(2);

		const fetchMock = stubOkFetch();

		await requestAsync({ topic: "run-1-cancel" });
		const [, init] = fetchMock.mock.calls[0]!;

		expect(init!.body).toBe(JSON.stringify({ topic: "run-1-cancel" }));
		expect(init!.headers).toMatchObject({ "content-type": "application/json" });
	});

	it("should classify a non-2xx response as an api failure carrying the body", async () => {
		expect.assertions(2);

		vi.stubGlobal(
			"fetch",
			vi
				.fn<typeof fetch>()
				.mockResolvedValue(fromAny(new Response("quota", { status: 429 }))),
		);

		const result = await requestAsync();

		expect(result.success).toBeFalse();
		expect(result).toMatchObject({ err: { message: "HTTP 429: quota", statusCode: 429 } });
	});

	it("should classify a thrown fetch as a network failure keeping its cause", async () => {
		expect.assertions(1);

		const cause = new Error("socket hang up");
		vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(cause));

		const result = await requestAsync();

		// The cause travels so a caller can walk to the original transport
		// error rather than re-parsing the message.
		expect(result).toMatchObject({
			err: { cause, message: "socket hang up" },
			success: false,
		});
	});

	it("should stringify a non-Error rejection", async () => {
		expect.assertions(1);

		vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue("wire torn"));

		const result = await requestAsync();

		expect(result).toMatchObject({ err: { message: "wire torn" }, success: false });
	});
});
