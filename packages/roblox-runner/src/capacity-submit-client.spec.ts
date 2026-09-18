import { ApiError, RateLimitError } from "@bedrock-rbx/ocale";
import type { HttpRequest } from "@bedrock-rbx/ocale";
import { createFakeHttpClient } from "@bedrock-rbx/ocale/testing";

import { assert, describe, expect, it, vi } from "vitest";

import { type CapacityProgress, createCapacitySubmitClient } from "./capacity-submit-client.ts";

const PREFIX =
	"universes/123/places/456/versions/1/luau-execution-sessions/11111111-1111-4111-8111-111111111111/tasks/";
const SUBMIT_URL = "/cloud/v2/universes/123/places/456/luau-execution-session-tasks";
const CONFIG = { apiKey: "key", baseUrl: "https://apis.roblox.com" };

function capacityError(refs: ReadonlyArray<string>, remaining = 3): RateLimitError {
	return new RateLimitError("Rate limited", {
		details: {
			code: "RESOURCE_EXHAUSTED",
			message: `Too many tasks already active. Task resource paths: ${refs.join(", ")}`,
		},
		remaining,
		retryAfterSeconds: 5,
		statusCode: 429,
	});
}

function taskRef(index: number): string {
	return `${PREFIX}22222222-2222-4222-8222-${String(index).padStart(12, "0")}`;
}

describe(createCapacitySubmitClient, () => {
	it("should report the server-directed wait for an exhausted create quota", async () => {
		expect.assertions(2);

		const http = createFakeHttpClient();
		http.mockError(new RateLimitError("quota", { remaining: 0, retryAfterSeconds: 0.25 }));
		const onAdmissionWait = vi.fn<(milliseconds: number) => void>();
		const client = createCapacitySubmitClient(http, {
			onAdmissionWait,
			placeId: "456",
			universeId: "123",
		});
		await client.request({ method: "POST", url: SUBMIT_URL }, CONFIG);

		expect(onAdmissionWait).toHaveBeenCalledExactlyOnceWith(250);
		expect(http.requests).toHaveLength(1);
	});

	it.for<{
		method: HttpRequest["method"];
		remaining: number | undefined;
		retryAfterSeconds: number;
		url: string;
	}>([
		{ method: "GET", remaining: 0, retryAfterSeconds: 60, url: SUBMIT_URL },
		{ method: "POST", remaining: 0, retryAfterSeconds: 60, url: "/cloud/v2/other" },
		{ method: "POST", remaining: 3, retryAfterSeconds: 60, url: SUBMIT_URL },
		{ method: "POST", remaining: undefined, retryAfterSeconds: 60, url: SUBMIT_URL },
		{ method: "POST", remaining: 0, retryAfterSeconds: 0, url: SUBMIT_URL },
		{ method: "POST", remaining: 0, retryAfterSeconds: -1, url: SUBMIT_URL },
		{ method: "POST", remaining: 0, retryAfterSeconds: NaN, url: SUBMIT_URL },
		{
			method: "POST",
			remaining: 0,
			retryAfterSeconds: Infinity,
			url: SUBMIT_URL,
		},
		{ method: "POST", remaining: 0, retryAfterSeconds: Number.MAX_VALUE, url: SUBMIT_URL },
	])(
		"should not exempt quota waits without valid evidence: %j",
		async ({ method, remaining, retryAfterSeconds, url }) => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockError(new RateLimitError("quota", { remaining, retryAfterSeconds }));
			const onAdmissionWait = vi.fn<(milliseconds: number) => void>();
			const client = createCapacitySubmitClient(http, {
				onAdmissionWait,
				placeId: "456",
				universeId: "123",
			});
			await client.request({ method, url }, CONFIG);

			expect(onAdmissionWait).not.toHaveBeenCalled();
		},
	);

	it("should canonicalize reordered duplicate blocker progress", async () => {
		expect.assertions(3);

		const http = createFakeHttpClient();
		const first = taskRef(1);
		const second = taskRef(2);
		http.mockError(capacityError([second, first, second]));
		http.mockResponse({ body: { state: "COMPLETE" }, status: 200 });
		http.mockError(capacityError([first, second, first]));
		http.mockResponse({ body: { state: "COMPLETE" }, status: 200 });
		const progress = new Array<CapacityProgress>();
		const client = createCapacitySubmitClient(http, {
			onCapacityProgress: (value) => {
				progress.push(value);
			},
			placeId: "456",
			universeId: "123",
		});

		await client.request({ method: "POST", url: SUBMIT_URL }, CONFIG);
		await client.request({ method: "POST", url: SUBMIT_URL }, CONFIG);

		const blockerProgress = [progress[0], progress[2]];

		expect(blockerProgress).toHaveLength(2);
		expect(blockerProgress[0]!.fingerprint).toBe(blockerProgress[1]!.fingerprint);
		expect(progress.map(({ fingerprint }) => fingerprint)).toStrictEqual([
			blockerProgress[0]!.fingerprint,
			`terminal:/cloud/v2/${first}?view=BASIC`,
			blockerProgress[1]!.fingerprint,
			`terminal:/cloud/v2/${first}?view=BASIC`,
		]);
	});

	it.for(["PROCESSING", "QUEUED"])(
		"should wait for a %s blocker before permitting another submit",
		async (state) => {
			expect.assertions(5);

			const http = createFakeHttpClient();
			const refs = Array.from({ length: 10 }, (_, index) => taskRef(index));
			http.mockError(capacityError(refs));
			for (let cycle = 0; cycle < 2; cycle += 1) {
				for (const _ref of refs) {
					http.mockResponse({ body: { state }, status: 200 });
				}
			}

			http.mockResponse({ body: { state: "COMPLETE" }, status: 200 });
			http.mockResponse({ body: { state: "QUEUED" }, status: 200 });
			const waitAsync = vi.fn<(ms: number, signal: AbortSignal | undefined) => Promise<void>>(
				async () => {},
			);
			const onAdmissionWait = vi.fn<(milliseconds: number) => void>();
			const client = createCapacitySubmitClient(http, {
				onAdmissionWait,
				placeId: "456",
				universeId: "123",
				waitAsync,
			});

			await client.request({ method: "POST", url: SUBMIT_URL }, CONFIG);

			expect(http.requests.filter(({ request }) => request.method === "POST")).toHaveLength(
				1,
			);
			expect({
				credits: onAdmissionWait.mock.calls.map(([milliseconds]) => milliseconds),
				waits: waitAsync.mock.calls.map(([milliseconds]) => milliseconds),
			}).toStrictEqual({ credits: [5000, 5000], waits: [5000, 5000] });
			expect(http.requests.filter(({ request }) => request.method === "GET")).toHaveLength(
				21,
			);

			const firstRead = http.requests[1];
			assert(firstRead !== undefined);

			expect(firstRead.request.url).toBe(`/cloud/v2/${refs[0]}?view=BASIC`);

			await client.request({ method: "POST", url: SUBMIT_URL }, CONFIG);

			expect(http.requests.filter(({ request }) => request.method === "POST")).toHaveLength(
				2,
			);
		},
	);

	it.for([
		{
			expected: [1000],
			readMs: 59_000,
			simulateReadAsync: async () => {
				await new Promise<void>((resolve) => {
					setTimeout(resolve, 59_000);
				});
			},
		},
		{
			expected: [],
			readMs: 60_000,
			simulateReadAsync: async () => {
				vi.setSystemTime(Date.now() + 60_000);
			},
		},
		{
			expected: [],
			readMs: 61_000,
			simulateReadAsync: async () => {
				vi.setSystemTime(Date.now() + 61_000);
			},
		},
	])(
		"should credit only the remaining capacity window after a $readMs ms read",
		async ({ expected, simulateReadAsync }) => {
			expect.assertions(3);

			const onAdmissionWait = vi.fn<(milliseconds: number) => void>();
			const waitAsync = vi.fn<(milliseconds: number) => Promise<void>>(
				async (milliseconds) => {
					await new Promise<void>((resolve) => {
						setTimeout(resolve, milliseconds);
					});
				},
			);
			vi.useFakeTimers();
			try {
				const http = createFakeHttpClient();
				http.mockError(capacityError([taskRef(1)]));
				http.mockResponse({ body: { state: "PROCESSING" }, status: 200 });
				http.mockResponse({ body: { state: "COMPLETE" }, status: 200 });
				const send = http.request.bind(http);
				vi.spyOn(http, "request")
					.mockImplementationOnce(send)
					.mockImplementationOnce(async (request, config) => {
						await simulateReadAsync();
						return send(request, config);
					});
				const submitted = createCapacitySubmitClient(http, {
					onAdmissionWait,
					placeId: "456",
					universeId: "123",
					waitAsync,
				}).request({ method: "POST", url: SUBMIT_URL }, CONFIG);
				await vi.runAllTimersAsync();

				await expect(submitted).resolves.toMatchObject({ success: false });
			} finally {
				vi.useRealTimers();
			}

			expect(onAdmissionWait.mock.calls.map(([milliseconds]) => milliseconds)).toStrictEqual(
				expected,
			);
			expect(waitAsync.mock.calls.map(([milliseconds]) => milliseconds)).toStrictEqual(
				expected,
			);
		},
	);

	it("should not credit or schedule a wait after the final blocker read is canceled", async () => {
		expect.assertions(4);

		const controller = new AbortController();
		const failure = new Error("stopped during read");
		const http = createFakeHttpClient();
		http.mockError(capacityError([taskRef(1)]));
		http.mockResponse({ body: { state: "PROCESSING" }, status: 200 });
		const send = http.request.bind(http);
		vi.spyOn(http, "request")
			.mockImplementationOnce(send)
			.mockImplementationOnce(async (request, config) => {
				const result = await send(request, config);
				controller.abort(failure);
				return result;
			});
		const onAdmissionWait = vi.fn<(milliseconds: number) => void>();
		const waitAsync = vi.fn<(ms: number, signal: AbortSignal | undefined) => Promise<void>>();
		const client = createCapacitySubmitClient(http, {
			onAdmissionWait,
			placeId: "456",
			universeId: "123",
			waitAsync,
		});

		await expect(
			client.request(
				{ method: "POST", url: SUBMIT_URL },
				{ ...CONFIG, signal: controller.signal },
			),
		).rejects.toBe(failure);
		expect(onAdmissionWait).not.toHaveBeenCalled();
		expect(waitAsync).not.toHaveBeenCalled();
		expect(http.requests).toHaveLength(2);
	});

	it("should abort reads without poisoning a later request", async () => {
		expect.assertions(4);

		const controller = new AbortController();
		const http = createFakeHttpClient();
		http.mockError(capacityError([taskRef(1)]));
		http.mockResponse({ body: { state: "PROCESSING" }, status: 200 });
		http.mockResponse({ body: { state: "QUEUED" }, status: 200 });
		const waitAsync = vi.fn<(ms: number, signal: AbortSignal | undefined) => Promise<void>>(
			async (_ms, signal) => {
				controller.abort(new Error("stopped"));
				signal!.throwIfAborted();
			},
		);
		const client = createCapacitySubmitClient(http, {
			placeId: "456",
			universeId: "123",
			waitAsync,
		});

		await expect(
			client.request(
				{ method: "POST", url: SUBMIT_URL },
				{ ...CONFIG, signal: controller.signal },
			),
		).rejects.toThrow("stopped");
		expect(http.requests.filter(({ request }) => request.method === "GET")).toHaveLength(1);
		expect(http.requests.filter(({ request }) => request.method === "POST")).toHaveLength(1);

		await client.request({ method: "POST", url: SUBMIT_URL }, CONFIG);

		expect(http.requests.filter(({ request }) => request.method === "POST")).toHaveLength(2);
	});

	it("should not begin blocker reads for an already-aborted request", async () => {
		expect.assertions(2);

		const controller = new AbortController();
		controller.abort(new Error("stopped"));
		const http = createFakeHttpClient();
		http.mockError(capacityError([taskRef(1)]));
		const client = createCapacitySubmitClient(http, { placeId: "456", universeId: "123" });

		await expect(
			client.request(
				{ method: "POST", url: SUBMIT_URL },
				{ ...CONFIG, signal: controller.signal },
			),
		).rejects.toThrow("stopped");
		expect(http.requests).toHaveLength(1);
	});

	it("should make the default wait cancelable", async () => {
		expect.assertions(3);

		const controller = new AbortController();
		vi.useFakeTimers();
		try {
			const http = createFakeHttpClient();
			http.mockError(capacityError([taskRef(1)]));
			http.mockResponse({ body: { state: "PROCESSING" }, status: 200 });
			const submitted = createCapacitySubmitClient(http, {
				placeId: "456",
				universeId: "123",
			}).request(
				{ method: "POST", url: SUBMIT_URL },
				{ ...CONFIG, signal: controller.signal },
			);
			const settled = submitted.catch((err: unknown) => err);
			await vi.advanceTimersByTimeAsync(0);
			controller.abort(new Error("cancelled"));
			await vi.runAllTimersAsync();

			await expect(settled).resolves.toMatchObject({ message: "The operation was aborted" });
			expect(http.requests).toHaveLength(2);
		} finally {
			vi.useRealTimers();
		}

		expect(controller.signal.aborted).toBeTrue();
	});

	it("should stop observing blockers at its independent deadline", async () => {
		expect.assertions(2);

		let requestCount = 0;
		vi.useFakeTimers();
		try {
			const http = createFakeHttpClient();
			http.mockError(capacityError([taskRef(1)]));
			for (let cycle = 0; cycle < 12; cycle += 1) {
				http.mockResponse({ body: { state: "PROCESSING" }, status: 200 });
			}

			const submitted = createCapacitySubmitClient(http, {
				placeId: "456",
				universeId: "123",
			}).request({ method: "POST", url: SUBMIT_URL }, CONFIG);
			const settled = submitted.catch((err: unknown) => err);
			await vi.advanceTimersByTimeAsync(60_000);

			await expect(settled).resolves.toMatchObject({ success: false });

			requestCount = http.requests.length;
		} finally {
			vi.useRealTimers();
		}

		expect(requestCount).toBe(2);
	});

	it("should defer to the SDK when quota itself is exhausted", async () => {
		expect.assertions(2);

		const http = createFakeHttpClient();
		http.mockError(capacityError([taskRef(1)], 0));
		const waitAsync = vi.fn<(ms: number, signal: AbortSignal | undefined) => Promise<void>>(
			async () => {},
		);
		const client = createCapacitySubmitClient(http, {
			placeId: "456",
			universeId: "123",
			waitAsync,
		});

		await expect(
			client.request({ method: "POST", url: SUBMIT_URL }, CONFIG),
		).resolves.toMatchObject({
			success: false,
		});
		expect(waitAsync).not.toHaveBeenCalled();
	});

	it("should reject malformed and foreign blocker paths", async () => {
		expect.assertions(3);

		const http = createFakeHttpClient();
		http.mockError(
			capacityError([
				"universes/123/places/456/versions/1/luau-execution-sessions/not-a-uuid/tasks/not-a-uuid",
			]),
		);
		http.mockError(capacityError(["universes/999/places/456/versions/1/sessions/s/tasks/t"]));
		http.mockError(new RateLimitError("limited", { retryAfterSeconds: 1, statusCode: 429 }));
		const client = createCapacitySubmitClient(http, { placeId: "456", universeId: "123" });

		await expect(
			client.request({ method: "POST", url: SUBMIT_URL }, CONFIG),
		).resolves.toMatchObject({ success: false });
		await expect(
			client.request({ method: "POST", url: SUBMIT_URL }, CONFIG),
		).resolves.toMatchObject({ success: false });
		await expect(
			client.request({ method: "POST", url: SUBMIT_URL }, CONFIG),
		).resolves.toMatchObject({ success: false });
	});

	it("should preserve unrelated requests and non-capacity errors", async () => {
		expect.assertions(2);

		const http = createFakeHttpClient();
		http.mockError(new ApiError("bad", { statusCode: 400 }));
		http.mockResponse({ body: {}, status: 200 });
		const client = createCapacitySubmitClient(http, { placeId: "456", universeId: "123" });

		await expect(
			client.request({ method: "POST", url: SUBMIT_URL }, CONFIG),
		).resolves.toMatchObject({ success: false });
		await expect(
			client.request({ method: "POST", url: "/other" }, CONFIG),
		).resolves.toMatchObject({ success: true });
	});

	it("should fall back when a blocker cannot be read", async () => {
		expect.assertions(4);

		const http = createFakeHttpClient();
		http.mockError(capacityError([taskRef(1)]));
		http.mockError(new ApiError("denied", { statusCode: 403 }));
		http.mockError(capacityError([taskRef(2)]));
		http.mockResponse({ body: { state: "UNKNOWN" }, status: 200 });
		const onAdmissionWait = vi.fn<(milliseconds: number) => void>();
		const waitAsync = vi.fn<(ms: number, signal: AbortSignal | undefined) => Promise<void>>();
		const client = createCapacitySubmitClient(http, {
			onAdmissionWait,
			placeId: "456",
			universeId: "123",
			waitAsync,
		});

		await expect(
			client.request({ method: "POST", url: SUBMIT_URL }, CONFIG),
		).resolves.toMatchObject({ success: false });
		await expect(
			client.request({ method: "POST", url: SUBMIT_URL }, CONFIG),
		).resolves.toMatchObject({ success: false });
		expect(onAdmissionWait).not.toHaveBeenCalled();
		expect(waitAsync).not.toHaveBeenCalled();
	});
});
