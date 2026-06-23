import { createFakeHttpClient, type FakeHttpClient } from "@bedrock-rbx/ocale/testing";

import { describe, expect, it } from "vitest";

import { ProgressMap } from "./progress-map.ts";

interface Tally {
	tested: number;
}

function makeMap(
	httpClient: FakeHttpClient,
	overrides: { decode?: (value: unknown) => Tally } = {},
): ProgressMap<Tally> {
	return new ProgressMap<Tally>({
		apiKey: "test-key",
		decode: overrides.decode ?? ((value) => value as Tally),
		httpClient,
		mapId: "run-1",
		universeId: "123",
	});
}

function validItemBody(id: string, value: unknown): Record<string, unknown> {
	return {
		id,
		etag: "etag-1",
		expireTime: "2026-06-21T15:08:58.4806559Z",
		path: `cloud/v2/universes/123/memory-store/sorted-maps/run-1/items/${id}`,
		value,
	};
}

describe(ProgressMap, () => {
	it("should list and decode every per-task counter value", async () => {
		expect.assertions(2);

		const http = createFakeHttpClient();
		http.mockResponse({
			body: {
				items: [
					validItemBody("task-a", { tested: 3 }),
					validItemBody("task-b", { tested: 5 }),
				],
			},
			status: 200,
		});

		const map = makeMap(http);
		const tallies = await map.readAll();

		expect(tallies).toStrictEqual([{ tested: 3 }, { tested: 5 }]);
		expect(http.requests[0]!.request.url).toContain(
			"/universes/123/memory-store/sorted-maps/run-1/items",
		);
	});

	it("should page through the continuation token until exhausted", async () => {
		expect.assertions(3);

		const http = createFakeHttpClient();
		http.mockResponse({
			body: { items: [validItemBody("task-a", { tested: 1 })], nextPageToken: "page-2" },
			status: 200,
		});
		http.mockResponse({
			body: { items: [validItemBody("task-b", { tested: 2 })] },
			status: 200,
		});

		const map = makeMap(http);
		const tallies = await map.readAll();

		expect(tallies).toStrictEqual([{ tested: 1 }, { tested: 2 }]);
		expect(http.requests).toHaveLength(2);
		expect(http.requests[1]!.request.url).toContain("pageToken=page-2");
	});

	it("should decode each value through the injected decoder", async () => {
		expect.assertions(1);

		const http = createFakeHttpClient();
		http.mockResponse({
			body: { items: [validItemBody("task-a", { tested: 7 })] },
			status: 200,
		});

		const map = makeMap(http, {
			decode: (value) => ({ tested: (value as Tally).tested * 10 }),
		});
		const tallies = await map.readAll();

		expect(tallies).toStrictEqual([{ tested: 70 }]);
	});

	it("should throw when the list call returns an API error", async () => {
		expect.assertions(1);

		const http = createFakeHttpClient();
		http.mockApiError({ message: "Forbidden", statusCode: 403 });

		const map = makeMap(http);

		await expect(map.readAll()).rejects.toThrow(/Forbidden/);
	});

	describe("construction", () => {
		it("should construct with the default http client when none is provided", () => {
			expect.assertions(1);

			const map = new ProgressMap<Tally>({
				apiKey: "test-key",
				decode: (value) => value as Tally,
				mapId: "run-1",
				universeId: "123",
			});

			expect(map).toBeInstanceOf(ProgressMap);
		});

		it("should accept an injected sleep function", () => {
			expect.assertions(1);

			async function sleep(): Promise<void> {}

			const map = new ProgressMap<Tally>({
				apiKey: "test-key",
				decode: (value) => value as Tally,
				mapId: "run-1",
				sleep,
				universeId: "123",
			});

			expect(map).toBeInstanceOf(ProgressMap);
		});

		it("should route traffic through a custom baseUrl when supplied", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockResponse({ body: { items: [] }, status: 200 });

			const map = new ProgressMap<Tally>({
				apiKey: "test-key",
				baseUrl: "http://127.0.0.1:4010",
				decode: (value) => value as Tally,
				httpClient: http,
				mapId: "run-1",
				universeId: "123",
			});
			await map.readAll();

			expect(http.requests[0]!.config.baseUrl).toBe("http://127.0.0.1:4010");
		});
	});
});
