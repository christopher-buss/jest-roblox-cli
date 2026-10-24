import { ApiError, NetworkError } from "@bedrock-rbx/ocale";
import { LuauExecutionClient } from "@bedrock-rbx/ocale/luau-execution";
import { PlacesClient } from "@bedrock-rbx/ocale/places";
import {
	createFakeHttpClient,
	createFakeSleep,
	validBinaryInputBody,
} from "@bedrock-rbx/ocale/testing";
import { fromAny } from "@total-typescript/shoehorn";

import buffer from "node:buffer";
import path from "node:path";
import { assert, describe, expect, it, vi } from "vitest";

import { CloudUploads } from "./cloud-uploads.ts";

function makeUploads(
	overrides: {
		fetch?: typeof globalThis.fetch;
		maxRetries?: number;
		readFile?: (filePath: string) => buffer.Buffer;
	} = {},
) {
	const http = createFakeHttpClient();
	const options = {
		apiKey: "key",
		httpClient: http,
		maxRetries: overrides.maxRetries ?? 0,
		sleep: createFakeSleep(),
	};
	const uploads = new CloudUploads({
		credentials: { apiKey: "key", placeId: "456", universeId: "123" },
		fetch: vi.fn<typeof globalThis.fetch>(async () => {
			return fromAny(new Response("", { status: 200 }));
		}),
		luau: new LuauExecutionClient(options),
		places: new PlacesClient(options),
		readFile: () => buffer.Buffer.from('<roblox version="4"></roblox>'),
		...overrides,
	});
	return { http, uploads };
}

describe(CloudUploads, () => {
	it.for([
		{ kind: "Saved", publish: false },
		{ kind: "Published", publish: true },
	])("should retain place version and upload duration: %j", async ({ kind, publish }) => {
		expect.assertions(2);

		const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
		const { http, uploads } = makeUploads({
			readFile: () => {
				clock.mockReturnValue(1543);
				return buffer.Buffer.from('<roblox version="4"></roblox>');
			},
		});
		http.mockResponse({ body: { versionNumber: 9 }, status: 200 });

		await expect(
			uploads.uploadPlaceAsync({ placeFilePath: "place.rbxlx", publish }),
		).resolves.toStrictEqual({ uploadMs: 543, versionNumber: 9 });
		expect(http.requests[0]!.request.url).toContain(`versionType=${kind}`);
	});

	it("should retain binary resource, payload and upload duration", async () => {
		expect.assertions(2);

		const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
		const fetch = vi.fn<typeof globalThis.fetch>(async () => {
			clock.mockReturnValue(3000);
			return fromAny(new Response("", { status: 200 }));
		});
		const { http, uploads } = makeUploads({ fetch });
		http.mockResponse({
			body: validBinaryInputBody({
				path: "universes/123/luau-execution-session-task-binary-inputs/input-1",
				uploadUri: "https://upload.example/slot-1",
			}),
			status: 200,
		});
		const payload = new Uint8Array([1, 2, 3]);

		await expect(uploads.uploadBinaryInputAsync({ payload })).resolves.toStrictEqual({
			path: "universes/123/luau-execution-session-task-binary-inputs/input-1",
			uploadMs: 2000,
		});
		expect(fetch).toHaveBeenCalledExactlyOnceWith("https://upload.example/slot-1", {
			body: payload,
			method: "PUT",
		});
	});

	it.for([
		{
			error: new ApiError("quota", { statusCode: 400 }),
			message: "Failed to allocate a binary input slot (HTTP 400): quota",
		},
		{
			error: new NetworkError("socket hang up"),
			message: "Failed to allocate a binary input slot: socket hang up",
		},
	])(
		"should surface a rejected allocation before uploading bytes: $message",
		async ({ error, message }) => {
			expect.assertions(3);

			const fetch = vi.fn<typeof globalThis.fetch>();
			const { http, uploads } = makeUploads({ fetch });
			http.mockError(error);

			const caught: unknown = await uploads
				.uploadBinaryInputAsync({ payload: new Uint8Array() })
				.catch((err: unknown) => err);
			assert(caught instanceof Error);

			expect(caught.message).toBe(message);
			expect(caught.cause).toBe(error);
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	it("should retain storage response text on a refused binary PUT", async () => {
		expect.assertions(1);

		const fetch = vi.fn<typeof globalThis.fetch>(async () => {
			return fromAny(new Response("expired", { status: 403 }));
		});
		const { http, uploads } = makeUploads({ fetch });
		http.mockResponse({
			body: validBinaryInputBody({
				path: "universes/123/luau-execution-session-task-binary-inputs/input-1",
				uploadUri: "https://upload.example/slot-1",
			}),
			status: 200,
		});

		await expect(uploads.uploadBinaryInputAsync({ payload: new Uint8Array() })).rejects.toThrow(
			"Failed to PUT the binary input (HTTP 403): expired",
		);
	});

	it("should identify the place file and SDK cause on upload failure", async () => {
		expect.assertions(1);

		const { http, uploads } = makeUploads();
		http.mockApiError({ message: "invalid key", statusCode: 401 });

		await expect(
			uploads.uploadPlaceAsync({ placeFilePath: "nested/place.rbxlx" }),
		).rejects.toMatchObject({
			cause: { message: "invalid key" },
			message: expect.stringContaining(
				`Failed to upload place ${path.resolve("nested/place.rbxlx")}: invalid key`,
			),
		});
	});

	it("should send an XML place file as XML", async () => {
		expect.assertions(1);

		const { http, uploads } = makeUploads();
		http.mockResponse({ body: { versionNumber: 1 }, status: 200 });
		await uploads.uploadPlaceAsync({ placeFilePath: "place.rbxlx" });

		expect(http.requests[0]!.request.headers!["content-type"]).toMatch(/xml/i);
	});

	it("should upload again when the same bytes are uploaded twice", async () => {
		expect.assertions(1);

		const { http, uploads } = makeUploads();
		http.mockResponse({ body: { versionNumber: 1 }, status: 200 });
		http.mockResponse({ body: { versionNumber: 2 }, status: 200 });
		await uploads.uploadPlaceAsync({ placeFilePath: "place.rbxlx" });
		await uploads.uploadPlaceAsync({ placeFilePath: "place.rbxlx" });

		expect(http.requests).toHaveLength(2);
	});
});

describe("place upload retries", () => {
	it.for([
		{ publish: false, statusCode: 502 },
		{ publish: true, statusCode: 503 },
	])(
		"should retry a rejected upload on a transient $statusCode: publish=$publish",
		async ({ publish, statusCode }) => {
			expect.assertions(2);

			const { http, uploads } = makeUploads({ maxRetries: 1 });
			http.mockApiError({ message: "unavailable", statusCode });
			http.mockResponse({ body: { versionNumber: 10 }, status: 200 });

			await expect(
				uploads.uploadPlaceAsync({ placeFilePath: "place.rbxlx", publish }),
			).resolves.toMatchObject({ versionNumber: 10 });
			expect(http.requests).toHaveLength(2);
		},
	);

	it.for([
		{
			error: new ApiError("HTTP 400", {
				gatewaySummary: "The requested URL could not be retrieved",
				statusCode: 400,
			}),
			kind: "gateway rejection",
		},
		{
			error: new NetworkError("read ECONNRESET", {
				cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
			}),
			kind: "connection reset",
		},
	])("should retry a place save after a $kind", async ({ error }) => {
		expect.assertions(2);

		const { http, uploads } = makeUploads({ maxRetries: 1 });
		http.mockError(error);
		http.mockResponse({ body: { versionNumber: 6 }, status: 200 });

		await expect(
			uploads.uploadPlaceAsync({ placeFilePath: "place.rbxlx" }),
		).resolves.toMatchObject({ versionNumber: 6 });
		expect(http.requests).toHaveLength(2);
	});
});
