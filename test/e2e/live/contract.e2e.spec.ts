import { type } from "arktype";
import buffer from "node:buffer";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import { assert, describe, expect, it, onTestFinished, vi } from "vitest";

import { openCloudExecutionBudgets } from "../../../src/backends/open-cloud-budgets.ts";
import type { JestResult } from "../../../src/types/jest-result.ts";
import { type FakeOpenCloudTask, startFakeOpenCloudServerAsync } from "../cli/fake-open-cloud.ts";
import { IS_BINARY_INPUT, IS_LIVE } from "./live-gate.ts";

interface HttpResponse {
	body: unknown;
	headers: Headers;
	ok: boolean;
	status: number;
}

interface HttpClient {
	request(
		method: string,
		url: string,
		options?: {
			body?: unknown;
			headers?: Record<string, string>;
			isIdempotent?: boolean;
			signal?: AbortSignal;
			timeoutMs?: number;
		},
	): Promise<HttpResponse>;
	readonly signal: AbortSignal;
}

// The contract suite asserts the response shapes the OpenCloudBackend reads
// from the wire (`src/backends/open-cloud.ts:176-177, 207-225, 257-279`).
// Each assertion runs twice: once against the in-process fake, once against
// the live `apis.roblox.com` URL (gated by JEST_ROBLOX_LIVE=1 plus
// credentials). If the fake's reply shape drifts from the live wire, one
// branch will fail.

const POLL_INTERVAL_MS = 1000;
const TASK_DEADLINE_SECONDS = 10;
const TASK_BOOT_GRACE_MS = 45_000;
const TASK_POLL_TIMEOUT_MS = TASK_DEADLINE_SECONDS * 1000 + TASK_BOOT_GRACE_MS;
const TASK_CREATE_RETRY_BUDGET_MS = openCloudExecutionBudgets(
	TASK_DEADLINE_SECONDS * 1000,
).maximumSubmitMs;
const IDEMPOTENT_TEST_TIMEOUT_MS = (TASK_CREATE_RETRY_BUDGET_MS + TASK_POLL_TIMEOUT_MS) * 2 + 5000;
const RATE_LIMIT_RETRY_COUNT = 8;
const RATE_LIMIT_BASE_DELAY_MS = 1000;
const RATE_LIMIT_MAX_DELAY_MS = 10_000;

const PLACE_FIXTURE_PATH = path.resolve(__dirname, "../fixtures/live-place/game.rbxl");

const versionResponseSchema = type({ versionNumber: "number" });
const taskCreateResponseSchema = type({ path: "string" });
const binaryInputResponseSchema = type({ path: "string", uploadUri: "string" });
const taskStatusResponseSchema = type({
	"error?": { "message?": "string" },
	"output?": { "results?": "string[]" },
	"state": "'CANCELLED' | 'COMPLETE' | 'FAILED' | 'PROCESSING'",
});

const envelopeEntrySchema = type({
	"elapsedMs?": "number",
	"gameOutput?": "string",
	"jestOutput": "string",
});
const envelopeSchema = type({ entries: envelopeEntrySchema.array() });

interface ContractCase {
	apiKey: string;
	/**
	 * Returns the base URL plus credentials. For fake cases, this also starts
	 * a fresh fake server seeded with the supplied tasks. The fake server
	 * registers its own `onTestFinished` cleanup, so callers don't need to
	 * tear it down explicitly.
	 */
	resolve: (tasks: Array<FakeOpenCloudTask>) => Promise<{
		baseUrl: string;
		placeId: string;
		universeId: string;
	}>;
}

const liveCase = resolveLiveCase();
const fake: ContractCase = {
	apiKey: "test-api-key",
	resolve: async (tasks) => {
		const server = await startFakeOpenCloudServerAsync(tasks);
		return { baseUrl: server.baseUrl, placeId: "456", universeId: "123" };
	},
};
const cases =
	liveCase === undefined
		? [{ name: "fake", testCase: fake }]
		: [
				{ name: "fake", testCase: fake },
				{ name: "live", testCase: liveCase },
			];

describe.for(cases)("open Cloud contract ($name)", ({ name, testCase }) => {
	it(
		"should return a numeric versionNumber from a place upload",
		{ timeout: TASK_CREATE_RETRY_BUDGET_MS + 5000 },
		async () => {
			expect.assertions(1);

			const { baseUrl, placeId, universeId } = await testCase.resolve([{ jestOutput: "" }]);
			const http = createHttpClient(testCase.apiKey);
			const placeData = fs.readFileSync(PLACE_FIXTURE_PATH);
			const url = `${baseUrl}/universes/v1/${universeId}/places/${placeId}/versions?versionType=Saved`;

			const response = await http.request("POST", url, {
				body: placeData,
				headers: { "Content-Type": "application/octet-stream" },
			});
			assertResponseOk(response, "Place upload");

			expect(versionResponseSchema(response.body)).not.toBeInstanceOf(type.errors);
		},
	);

	// One create, and only one: the operation is metered at five a minute per
	// API key owner, and the live pipeline suite spends more of that same
	// allowance on the runs it makes.
	it.skipIf(name === "live" && !IS_BINARY_INPUT)(
		"should return a slot path and an upload uri from a binary-input create",
		{ timeout: TASK_CREATE_RETRY_BUDGET_MS + 5000 },
		async () => {
			expect.assertions(2);

			const { baseUrl, universeId } = await testCase.resolve([]);
			const http = createHttpClient(testCase.apiKey);
			const url = `${baseUrl}/cloud/v2/universes/${universeId}/luau-execution-session-task-binary-inputs`;

			const response = await http.request("POST", url, {
				body: { size: 64 },
				headers: { "Content-Type": "application/json" },
			});
			assertResponseOk(response, "Binary input create");
			const parsed = binaryInputResponseSchema.assert(response.body);

			// The client refuses a path it cannot read a universe and a slot out
			// of, so the shape of the string is as load-bearing as its presence.
			expect(parsed.path).toMatch(
				/^universes\/\d+\/luau-execution-session-task-binary-inputs\/[^/]+$/,
			);
			expect(parsed.uploadUri).toMatch(/^https?:\/\//);
		},
	);

	it(
		"should return an envelope-shaped results[0] when the script completes",
		async () => {
			expect.assertions(4);

			const { baseUrl, placeId, universeId } = await testCase.resolve([
				// Fake-only: queue a task whose `jestOutput` field gets wrapped
				// into the envelope shape. Live ignores this — the Luau script
				// produces the envelope itself.
				{ jestOutput: JSON.stringify(buildPassingJestPayload()) },
			]);
			const http = createHttpClient(testCase.apiKey);
			const status = await executeIdempotentScriptAsync({
				baseUrl,
				http,
				placeId,
				script: buildSuccessLuauScript(),
				universeId,
			});

			expect(status.state).toBe("COMPLETE");

			const results = status.output!.results!;
			const envelopeRaw = results[0];
			const parsed = parseEnvelope(envelopeRaw);

			expect(parsed).toBeDefined();
			// Assert at least one entry has a `jestOutput` string — the
			// minimum shape `parseEnvelope` and `buildProjectResult` rely on.
			expect(
				parsed!.entries.some((entry) => typeof entry.jestOutput === "string"),
			).toBeTrue();

			expect(isAbsentOrString(results[1])).toBeTrue();
		},
		IDEMPOTENT_TEST_TIMEOUT_MS,
	);

	it(
		"should return state=FAILED with a string error.message when the script errors",
		async () => {
			expect.assertions(2);

			const { baseUrl, placeId, universeId } = await testCase.resolve([
				{ errorMessage: "contract-failure", jestOutput: "", state: "FAILED" },
			]);
			const http = createHttpClient(testCase.apiKey);
			const status = await executeIdempotentScriptAsync({
				baseUrl,
				http,
				placeId,
				script: 'error("contract-failure")',
				universeId,
			});

			expect(status.state).toBe("FAILED");
			expect(status.error!.message).toBeString();
		},
		IDEMPOTENT_TEST_TIMEOUT_MS,
	);
});

describe("idempotent contract task recovery", () => {
	it("should replace one task that stays processing", async () => {
		expect.assertions(2);

		const server = await startFakeOpenCloudServerAsync([
			{ pollsBeforeComplete: Number.MAX_SAFE_INTEGER },
			{ rawOutput: "complete" },
		]);
		const status = await executeIdempotentScriptAsync({
			baseUrl: server.baseUrl,
			http: createHttpClient("test-api-key"),
			placeId: "456",
			pollIntervalMs: 1,
			pollTimeoutMs: 10,
			script: 'return "complete"',
			universeId: "123",
		});

		expect(status.state).toBe("COMPLETE");
		expect(server.requests).toHaveLength(2);
	});

	it("should report both task paths when both attempts stay processing", async () => {
		expect.assertions(2);

		const server = await startFakeOpenCloudServerAsync([
			{ pollsBeforeComplete: Number.MAX_SAFE_INTEGER },
			{ pollsBeforeComplete: Number.MAX_SAFE_INTEGER },
		]);
		const execution = executeIdempotentScriptAsync({
			baseUrl: server.baseUrl,
			http: createHttpClient("test-api-key"),
			placeId: "456",
			pollIntervalMs: 1,
			pollTimeoutMs: 10,
			script: 'return "complete"',
			universeId: "123",
		});

		await expect(execution).rejects.toThrow(/task-1.*task-2/u);
		expect(server.requests).toHaveLength(2);
	});

	it("should not replace a task with a terminal failure", async () => {
		expect.assertions(2);

		const server = await startFakeOpenCloudServerAsync([
			{ errorMessage: "failed", state: "FAILED" },
			{ rawOutput: "must-not-run" },
		]);
		const status = await executeIdempotentScriptAsync({
			baseUrl: server.baseUrl,
			http: createHttpClient("test-api-key"),
			placeId: "456",
			pollIntervalMs: 1,
			pollTimeoutMs: 10,
			script: 'return "complete"',
			universeId: "123",
		});

		expect(status.state).toBe("FAILED");
		expect(server.requests).toHaveLength(1);
	});

	it("should not replace a task after an invalid poll response", async () => {
		expect.assertions(2);

		const methods: Array<string> = [];
		const http = invalidStatusHttp(methods);
		const execution = executeIdempotentScriptAsync({
			baseUrl: "https://example.invalid",
			http,
			placeId: "456",
			pollIntervalMs: 1,
			pollTimeoutMs: 10,
			script: 'return "complete"',
			universeId: "123",
		});

		await expect(execution).rejects.toThrow(/state must be/u);
		expect(methods).toStrictEqual(["POST", "GET"]);
	});
});

describe("rate-limited contract HTTP", () => {
	it("should preserve a real FAILED response after quota windows and one stalled task", async () => {
		expect.assertions(3);

		vi.useFakeTimers();
		function quota(): Response {
			return new Response("quota", { headers: { "Retry-After": "60" }, status: 429 });
		}

		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(quota())
			.mockResolvedValueOnce(quota())
			.mockResolvedValueOnce(Response.json({ path: "universes/123/tasks/first" }))
			.mockResolvedValueOnce(Response.json({ state: "PROCESSING" }))
			.mockResolvedValueOnce(quota())
			.mockResolvedValueOnce(quota())
			.mockResolvedValueOnce(Response.json({ path: "universes/123/tasks/second" }))
			.mockResolvedValueOnce(
				Response.json({ error: { message: "contract-failure" }, state: "FAILED" }),
			);
		vi.stubGlobal("fetch", fetchMock);
		onTestFinished(() => {
			vi.useRealTimers();
			vi.unstubAllGlobals();
		});
		const execution = executeIdempotentScriptAsync({
			baseUrl: "https://example.invalid",
			http: createHttpClient("key"),
			placeId: "456",
			pollIntervalMs: TASK_POLL_TIMEOUT_MS,
			script: 'error("contract-failure")',
			universeId: "123",
		});
		await vi.advanceTimersByTimeAsync(295_000);

		await expect(execution).resolves.toStrictEqual({
			error: { message: "contract-failure" },
			state: "FAILED",
		});
		expect(fetchMock).toHaveBeenCalledTimes(8);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("should cancel a retry wait when its caller aborts", { timeout: 1000 }, async () => {
		expect.assertions(3);

		vi.useFakeTimers();
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				new Response("quota", { headers: { "Retry-After": "60" }, status: 429 }),
			);
		vi.stubGlobal("fetch", fetchMock);
		onTestFinished(() => {
			vi.useRealTimers();
			vi.unstubAllGlobals();
		});
		const observation = new AbortController();
		const failure = new Error("test stopped");
		const request = createHttpClient("key")
			.request("POST", "https://example.invalid", {
				signal: observation.signal,
			})
			.catch((err: unknown) => err);
		await vi.advanceTimersByTimeAsync(1000);
		observation.abort(failure);

		await expect(request).resolves.toBe(failure);
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it(
		"should enforce admission even when a response never arrives",
		{ timeout: 1000 },
		async () => {
			expect.assertions(3);

			vi.useFakeTimers();
			const fetchMock = vi.fn<typeof fetch>(async () => new Promise<Response>(() => {}));
			vi.stubGlobal("fetch", fetchMock);
			onTestFinished(() => {
				vi.useRealTimers();
				vi.unstubAllGlobals();
			});
			const request = createHttpClient("key")
				.request("POST", "https://example.invalid", {
					timeoutMs: 1000,
				})
				.catch((err: unknown) => err);
			await vi.advanceTimersByTimeAsync(1000);

			await expect(request).resolves.toMatchObject({
				message: expect.stringContaining("1000ms"),
			});
			expect(fetchMock.mock.calls[0]![1]!.signal!.aborted).toBeTrue();
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it("should cancel polling between GET requests when the owner stops", async () => {
		expect.assertions(3);

		vi.useFakeTimers();
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(Response.json({ state: "PROCESSING" }));
		vi.stubGlobal("fetch", fetchMock);
		onTestFinished(() => {
			vi.useRealTimers();
			vi.unstubAllGlobals();
		});
		const observation = new AbortController();
		const failure = new Error("owner stopped");
		const polling = pollUntilTerminalAsync(
			{ ...createHttpClient("key"), signal: observation.signal },
			"https://example.invalid",
			"task-1",
			{ pollIntervalMs: 10_000, timeoutMs: 55_000 },
		).catch((err: unknown) => err);
		await vi.advanceTimersByTimeAsync(1000);
		observation.abort(failure);

		await expect(polling).resolves.toBe(failure);
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("should bound a throttled poll and replace only its timed-out task", async () => {
		expect.assertions(3);

		vi.useFakeTimers();
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(Response.json({ path: "universes/123/tasks/first" }))
			.mockResolvedValueOnce(
				new Response("quota", { headers: { "Retry-After": "60" }, status: 429 }),
			)
			.mockResolvedValueOnce(Response.json({ path: "universes/123/tasks/second" }))
			.mockResolvedValueOnce(
				Response.json({ error: { message: "contract-failure" }, state: "FAILED" }),
			);
		vi.stubGlobal("fetch", fetchMock);
		onTestFinished(() => {
			vi.useRealTimers();
			vi.unstubAllGlobals();
		});
		const execution = executeIdempotentScriptAsync({
			baseUrl: "https://example.invalid",
			http: createHttpClient("key"),
			placeId: "456",
			script: 'error("contract-failure")',
			universeId: "123",
		});
		await vi.advanceTimersByTimeAsync(55_000);

		await expect(execution).resolves.toMatchObject({ state: "FAILED" });
		expect(fetchMock).toHaveBeenCalledTimes(4);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.for([
		{ calls: 2, isIdempotent: false, method: "GET", status: 200 },
		{ calls: 1, isIdempotent: false, method: "POST", status: 502 },
		{ calls: 2, isIdempotent: true, method: "POST", status: 200 },
	])(
		"should handle a gateway failure for $method with idempotent=$isIdempotent",
		async (testCase) => {
			expect.assertions(2);

			vi.useFakeTimers();
			const fetchMock = vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(new Response("Bad gateway", { status: 502 }))
				.mockResolvedValueOnce(Response.json({ state: "COMPLETE" }));
			vi.stubGlobal("fetch", fetchMock);
			onTestFinished(() => {
				vi.useRealTimers();
				vi.unstubAllGlobals();
			});

			const pending = createHttpClient("test-api-key").request(
				testCase.method,
				"https://apis.roblox.com/cloud/v2/universes/123/tasks/456",
				{ isIdempotent: testCase.isIdempotent },
			);
			await vi.runAllTimersAsync();
			const response = await pending;

			expect(response.status).toBe(testCase.status);
			expect(fetchMock).toHaveBeenCalledTimes(testCase.calls);
		},
	);

	it("should wait for retry-after before retrying rate-limited task creation", async () => {
		expect.assertions(3);

		vi.useFakeTimers();
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ errors: [{ code: 0, message: "" }] }), {
					headers: { "Content-Type": "application/json", "Retry-After": "2" },
					status: 429,
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ path: "universes/123/tasks/456" }), {
					headers: { "Content-Type": "application/json" },
					status: 200,
				}),
			);
		vi.stubGlobal("fetch", fetchMock);
		onTestFinished(() => {
			vi.useRealTimers();
			vi.unstubAllGlobals();
		});

		const request = createHttpClient("test-api-key").request(
			"POST",
			"https://apis.roblox.com/cloud/v2/universes/123/places/456/luau-execution-session-tasks",
			{ body: { script: "return nil", timeout: "30s" } },
		);

		await vi.advanceTimersByTimeAsync(1999);

		expect(fetchMock).toHaveBeenCalledOnce();

		await vi.advanceTimersByTimeAsync(1);
		const response = await request;

		expect(response).toMatchObject({
			body: { path: "universes/123/tasks/456" },
			ok: true,
			status: 200,
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it.for([
		{
			headers: {
				"X-Ratelimit-Remaining": "3",
				"X-Ratelimit-Reset": "41",
			},
			waitMs: RATE_LIMIT_BASE_DELAY_MS,
		},
		{
			headers: {
				"Retry-After": "5",
				"X-Ratelimit-Remaining": "3",
				"X-Ratelimit-Reset": "41",
			},
			waitMs: 5000,
		},
		{
			headers: {
				"Retry-After": "5",
				"X-Ratelimit-Remaining": "0, 70000",
				"X-Ratelimit-Reset": "50, 0",
			},
			waitMs: 50_000,
		},
	])(
		"should retry task creation after the applicable quota window ($waitMs ms)",
		async ({ headers, waitMs }) => {
			expect.assertions(2);

			vi.useFakeTimers();
			const fetchMock = vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ errors: [{ code: 0, message: "capacity" }] }), {
						headers: { "Content-Type": "application/json", ...headers },
						status: 429,
					}),
				)
				.mockResolvedValueOnce(Response.json({ path: "universes/123/tasks/456" }));
			vi.stubGlobal("fetch", fetchMock);
			onTestFinished(() => {
				vi.useRealTimers();
				vi.unstubAllGlobals();
			});

			const request = createHttpClient("test-api-key").request(
				"POST",
				"https://apis.roblox.com/cloud/v2/universes/123/places/456/luau-execution-session-tasks",
				{ body: { script: "return nil", timeout: "10s" } },
			);

			await vi.advanceTimersByTimeAsync(waitMs - 1);

			expect(fetchMock).toHaveBeenCalledOnce();

			await vi.advanceTimersByTimeAsync(1);
			await request;

			expect(fetchMock).toHaveBeenCalledTimes(2);
		},
	);

	it("should report rate-limit diagnostics after exhausting retries", async () => {
		expect.assertions(2);

		vi.useFakeTimers();
		const fetchMock = vi.fn<typeof fetch>(async () => {
			return new Response(JSON.stringify({ errors: [{ code: 0, message: "" }] }), {
				headers: {
					"Content-Type": "application/json",
					"Retry-After": "1",
					"X-Envoy-Ratelimited": "true",
					"X-Ratelimit-Remaining": "0",
					"X-Ratelimit-Reset": "5",
				},
				status: 429,
			});
		});
		vi.stubGlobal("fetch", fetchMock);
		onTestFinished(() => {
			vi.useRealTimers();
			vi.unstubAllGlobals();
		});

		const task = createTaskAsync({
			baseUrl: "https://apis.roblox.com",
			http: createHttpClient("test-api-key"),
			placeId: "456",
			script: "return nil",
			universeId: "123",
		});
		const taskError = task.catch((err: unknown) => err);

		await vi.runAllTimersAsync();
		const error = await taskError;
		assert(error instanceof Error, "expected task creation to reject");

		expect(error.message).toMatch(
			/status=429.*retry-after=1.*x-envoy-ratelimited=true.*x-ratelimit-remaining=0.*x-ratelimit-reset=5.*"errors"/,
		);
		expect(fetchMock).toHaveBeenCalledTimes(9);
	});
});

class ContractPollTimeoutError extends Error {
	public override readonly name = "ContractPollTimeoutError";
	public readonly taskPath: string;

	constructor(taskPath: string, timeoutMs: number) {
		super(`Task ${taskPath} did not reach a terminal state within ${timeoutMs.toString()}ms`);
		this.taskPath = taskPath;
	}
}

/**
 * A `results` slot past the envelope is optional on the wire, but when present
 * the backend reads it as a string.
 */
function isAbsentOrString(value: string | undefined): boolean {
	return value === undefined || typeof value === "string";
}

function numericHeaderValues(headers: Headers, name: string): Array<number> {
	const value = headers.get(name);
	if (value === null) {
		return [];
	}

	return value
		.split(",")
		.map((entry) => Number(entry.trim()))
		.filter((entry) => Number.isFinite(entry));
}

function resolveRateLimitRetryDelayMs(headers: Headers, retryCount: number): number {
	const retryAfterSeconds = Math.max(0, ...numericHeaderValues(headers, "retry-after"));
	const remainingValues = numericHeaderValues(headers, "x-ratelimit-remaining");
	const resetSeconds = Math.max(0, ...numericHeaderValues(headers, "x-ratelimit-reset"));
	if (remainingValues.length > 0 && Math.min(...remainingValues) === 0 && resetSeconds > 0) {
		return Math.max(retryAfterSeconds, resetSeconds) * 1000;
	}

	if (retryAfterSeconds > 0) {
		return retryAfterSeconds * 1000;
	}

	return Math.min(RATE_LIMIT_BASE_DELAY_MS * 2 ** retryCount, RATE_LIMIT_MAX_DELAY_MS);
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new Error("Contract operation aborted", { cause: signal.reason });
}

async function withDeadlineAsync<T>(
	{
		signal: parentSignal,
		timeoutError,
		timeoutMs,
	}: {
		signal?: AbortSignal;
		timeoutError: Error;
		timeoutMs: number;
	},
	operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const deadline = new AbortController();
	const signal =
		parentSignal === undefined
			? deadline.signal
			: AbortSignal.any([parentSignal, deadline.signal]);
	const timer = setTimeout(() => {
		deadline.abort(timeoutError);
	}, timeoutMs);
	const canceled = Promise.withResolvers<never>();
	function abort(): void {
		canceled.reject(abortError(signal));
	}

	try {
		signal.throwIfAborted();
		signal.addEventListener("abort", abort, { once: true });
		return await Promise.race([operation(signal), canceled.promise]);
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
		deadline.abort();
	}
}

async function sleepAsync(ms: number, signal: AbortSignal): Promise<void> {
	signal.throwIfAborted();
	const waiting = Promise.withResolvers<void>();
	const timer = setTimeout(waiting.resolve, Math.min(ms, TASK_CREATE_RETRY_BUDGET_MS));
	function abort(): void {
		waiting.reject(abortError(signal));
	}

	signal.addEventListener("abort", abort, { once: true });

	try {
		await waiting.promise;
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
	}
}

function createHttpClient(apiKey: string): HttpClient {
	const observation = new AbortController();
	onTestFinished(() => {
		observation.abort(new Error("Contract test finished"));
	});
	return {
		// eslint-disable-next-line small-rules/require-async-suffix -- HttpClient contract uses the external method name.
		async request(method, url, options) {
			const timeoutMs = options?.timeoutMs ?? TASK_CREATE_RETRY_BUDGET_MS;
			return withDeadlineAsync(
				{
					signal:
						options?.signal === undefined
							? observation.signal
							: AbortSignal.any([observation.signal, options.signal]),
					timeoutError: new Error(
						`Contract HTTP ${method} did not finish within ${String(timeoutMs)}ms`,
					),
					timeoutMs,
				},
				async (signal) => {
					const headers = {
						"x-api-key": apiKey,
						...options?.headers,
					};

					const fetchOptions: RequestInit = { headers, method, signal };
					if (options?.body !== undefined) {
						if (options.body instanceof buffer.Buffer) {
							fetchOptions.body = options.body;
						} else {
							// `JSON.stringify` is typed as possibly returning
							// undefined, which `RequestInit.body` refuses under
							// exactOptionalPropertyTypes.
							const serialized = JSON.stringify(options.body);
							if (serialized !== undefined) {
								fetchOptions.body = serialized;
								fetchOptions.headers = {
									...headers,
									"Content-Type": "application/json",
								};
							}
						}
					}

					for (let retryCount = 0; ; retryCount += 1) {
						signal.throwIfAborted();
						const response = await fetch(url, fetchOptions);
						signal.throwIfAborted();
						const contentType = response.headers.get("content-type") ?? "";
						const body = contentType.includes("application/json")
							? await response.json()
							: await response.text();
						const result: HttpResponse = {
							body,
							headers: response.headers,
							ok: response.ok,
							status: response.status,
						};

						const isRetryable =
							response.status === 429 ||
							((method === "GET" || options?.isIdempotent === true) &&
								[500, 502, 503, 504].includes(response.status));
						if (!isRetryable || retryCount >= RATE_LIMIT_RETRY_COUNT) {
							return result;
						}

						await sleepAsync(
							resolveRateLimitRetryDelayMs(response.headers, retryCount),
							signal,
						);
					}
				},
			);
		},
		signal: observation.signal,
	};
}

function formatHttpFailure(response: HttpResponse): string {
	const headerNames = [
		"retry-after",
		"x-envoy-ratelimited",
		"x-ratelimit-remaining",
		"x-ratelimit-reset",
		"x-roblox-system-reason",
		"x-retry-after-coverage",
	];
	const headers = headerNames
		.map((name) => `${name}=${response.headers.get(name) ?? "<absent>"}`)
		.join("; ");
	const serializedBody = JSON.stringify(response.body) ?? String(response.body);

	return `status=${response.status.toString()}; ${headers}; body=${serializedBody}`;
}

function assertResponseOk(response: HttpResponse, operation: string): void {
	if (!response.ok) {
		throw new Error(`${operation} failed: ${formatHttpFailure(response)}`);
	}
}

function resolveLiveCase(): ContractCase | undefined {
	if (!IS_LIVE) {
		return undefined;
	}

	const apiKey = process.env["ROBLOX_OPEN_CLOUD_API_KEY"];
	const universeId = process.env["ROBLOX_UNIVERSE_ID"];
	const placeId = process.env["ROBLOX_PLACE_ID"];
	if (
		apiKey === undefined ||
		apiKey === "" ||
		universeId === undefined ||
		universeId === "" ||
		placeId === undefined ||
		placeId === ""
	) {
		return undefined;
	}

	return {
		apiKey,
		resolve: async () => {
			return {
				baseUrl: "https://apis.roblox.com",
				placeId,
				universeId,
			};
		},
	};
}

async function createTaskAsync({
	baseUrl,
	http,
	placeId,
	script,
	universeId,
}: {
	baseUrl: string;
	http: HttpClient;
	placeId: string;
	script: string;
	universeId: string;
}): Promise<string> {
	const url = `${baseUrl}/cloud/v2/universes/${universeId}/places/${placeId}/luau-execution-session-tasks`;
	const response = await http.request("POST", url, {
		body: { script, timeout: `${TASK_DEADLINE_SECONDS.toString()}s` },
		isIdempotent: true,
	});
	assertResponseOk(response, "Task creation");

	const parsed = taskCreateResponseSchema.assert(response.body);
	return parsed.path;
}

async function pollUntilTerminalAsync(
	http: HttpClient,
	baseUrl: string,
	taskPath: string,
	{
		pollIntervalMs = POLL_INTERVAL_MS,
		timeoutMs,
	}: { pollIntervalMs?: number; timeoutMs: number },
): Promise<typeof taskStatusResponseSchema.infer> {
	const url = `${baseUrl}/cloud/v2/${taskPath}`;
	return withDeadlineAsync(
		{
			signal: http.signal,
			timeoutError: new ContractPollTimeoutError(taskPath, timeoutMs),
			timeoutMs,
		},
		async (signal) => {
			while (true) {
				const response = await http.request("GET", url, { signal });
				assertResponseOk(response, "Task poll");

				const status = taskStatusResponseSchema.assert(response.body);
				if (status.state !== "PROCESSING") {
					return status;
				}

				await sleepAsync(pollIntervalMs, signal);
			}
		},
	);
}

async function executeIdempotentScriptAsync({
	baseUrl,
	http,
	placeId,
	pollIntervalMs = POLL_INTERVAL_MS,
	pollTimeoutMs = TASK_POLL_TIMEOUT_MS,
	script,
	universeId,
}: {
	baseUrl: string;
	http: HttpClient;
	placeId: string;
	pollIntervalMs?: number;
	pollTimeoutMs?: number;
	script: string;
	universeId: string;
}): Promise<typeof taskStatusResponseSchema.infer> {
	const timedOutTaskPaths: Array<string> = [];
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const taskPath = await createTaskAsync({ baseUrl, http, placeId, script, universeId });
		try {
			return await pollUntilTerminalAsync(http, baseUrl, taskPath, {
				pollIntervalMs,
				timeoutMs: pollTimeoutMs,
			});
		} catch (err) {
			if (!(err instanceof ContractPollTimeoutError)) {
				throw err;
			}

			timedOutTaskPaths.push(err.taskPath);
			if (attempt === 1) {
				throw new Error(
					`Contract tasks ${timedOutTaskPaths.join(" and ")} did not reach a terminal state`,
					{ cause: err },
				);
			}
		}
	}

	throw new Error("Unreachable contract task recovery state");
}

function invalidStatusHttp(methods: Array<string>): HttpClient {
	const observation = new AbortController();
	return {
		request: async (method) => {
			methods.push(method);
			if (method === "POST") {
				return {
					body: { path: "universes/123/tasks/task-1" },
					headers: new Headers(),
					ok: true,
					status: 200,
				};
			}

			return { body: { state: "UNKNOWN" }, headers: new Headers(), ok: true, status: 200 };
		},
		signal: observation.signal,
	};
}

function parseEnvelope(raw: string | undefined): typeof envelopeSchema.infer | undefined {
	if (raw === undefined) {
		return undefined;
	}

	const decoded = JSON.parse(raw);
	const result = envelopeSchema(decoded);
	if (result instanceof type.errors) {
		return undefined;
	}

	return result;
}

function buildPassingJestPayload(): JestResult {
	return {
		numFailedTests: 0,
		numPassedTests: 0,
		numPendingTests: 0,
		numTotalTests: 0,
		startTime: 0,
		success: true,
		testResults: [],
	};
}

function buildSuccessLuauScript(): string {
	// The live wire echoes whatever string the Luau script returns into
	// `output.results[0]`. Returning a JSON-encoded envelope here ensures the
	// parsed shape matches what `parseEnvelope` (in
	// `src/backends/open-cloud.ts`) expects.
	const envelope = {
		entries: [{ jestOutput: JSON.stringify(buildPassingJestPayload()) }],
	};

	return `return ${JSON.stringify(JSON.stringify(envelope))}`;
}
