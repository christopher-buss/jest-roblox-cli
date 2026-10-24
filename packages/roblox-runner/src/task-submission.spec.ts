import { ApiError, NetworkError, OpenCloudError, RateLimitError } from "@bedrock-rbx/ocale";
import type { HttpClient, SleepFunc } from "@bedrock-rbx/ocale";
import { LuauExecutionClient } from "@bedrock-rbx/ocale/luau-execution";
import {
	createFakeHttpClient,
	createFakeSleep,
	type FakeHttpClient,
} from "@bedrock-rbx/ocale/testing";
import { fromAny } from "@total-typescript/shoehorn";

import { type } from "arktype";
import { assert, describe, expect, it, onTestFinished, vi } from "vitest";

import type { ExecuteScriptOptions } from "./runner-types.ts";
import type { TaskQuotaError } from "./task-quota-error.ts";
import { TaskSubmission } from "./task-submission.ts";

const CREDENTIALS = { apiKey: "test-key", placeId: "456", universeId: "123" };
const CAPACITY_BLOCKER =
	"universes/123/places/456/versions/1/luau-execution-sessions/11111111-1111-4111-8111-111111111111/tasks/22222222-2222-4222-8222-222222222222";
const ACCEPTED = {
	createTime: "2026-01-01T00:00:00Z",
	path: "universes/123/places/456/versions/1/luau-execution-sessions/session-1/tasks/task-1",
	state: "QUEUED",
	updateTime: "2026-01-01T00:00:00Z",
	user: "user-1",
};
const BUDGETED = {
	placeVersion: 1,
	script: "return 1",
	submitBudget: 90_000,
	submitCapacityBudget: 405_000,
	timeout: 300_000,
};

const submitBodySchema = type({
	"binaryInput?": "string",
	"script": "string",
	"timeout": "string",
});

interface SubmissionOptions {
	capacityWaitAsync?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
	maxRetries?: number;
	sleep?: SleepFunc;
}

function makeSubmission(httpClient: HttpClient, options?: SubmissionOptions): TaskSubmission {
	const { capacityWaitAsync, ...clientOverrides } = options ?? { sleep: createFakeSleep() };
	const clientOptions = { apiKey: CREDENTIALS.apiKey, httpClient, ...clientOverrides };
	return new TaskSubmission({
		capacityWaitAsync,
		clientOptions,
		credentials: CREDENTIALS,
		luau: new LuauExecutionClient(clientOptions),
	});
}

async function submitScriptAsync(
	submission: TaskSubmission,
	options: Partial<ExecuteScriptOptions> = {},
): ReturnType<TaskSubmission["submitAsync"]> {
	const timeout = options.timeout ?? 30_000;
	return submission.submitAsync(
		{ script: "return 1", timeout, ...options },
		{ deadlineMs: Date.now() + timeout + 45_000, timeoutSeconds: timeout / 1000 },
	);
}

function acceptTask(http: FakeHttpClient): void {
	http.mockResponse({ body: ACCEPTED, status: 200 });
}

function useClock(): void {
	vi.useFakeTimers();
	onTestFinished(() => {
		vi.useRealTimers();
	});
}

async function sleepAsync(milliseconds: number, signal?: AbortSignal): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		function finish(): void {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}

		const timer = setTimeout(finish, milliseconds);
		function onAbort(): void {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(new Error("sleep aborted"));
		}

		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted === true) {
			onAbort();
		}
	});
}

async function fakeTimerSleepAsync(ms: number): Promise<void> {
	await new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});
}

async function scaledAdmissionSleepAsync(ms: number): Promise<void> {
	await new Promise<void>((resolve) => {
		setTimeout(resolve, ms >= 60_000 ? 65_000 : 5000);
	});
}

function capacityError({
	blocker = CAPACITY_BLOCKER,
	retryAfterSeconds = 5,
}: { blocker?: string; retryAfterSeconds?: number } = {}): RateLimitError {
	return new RateLimitError("Rate limited", {
		details: {
			code: "RESOURCE_EXHAUSTED",
			message: `Too many tasks already active: ${blocker}`,
		},
		remaining: 3,
		retryAfterSeconds,
		statusCode: 429,
	});
}

function queueOccupiedPlace(http: FakeHttpClient, rounds: number): void {
	const createdAt = new Date();
	const timestamp = createdAt.toISOString();
	const refs = Array.from({ length: 10 }, (_, index) => {
		return CAPACITY_BLOCKER.replace(/222222222222$/u, () => {
			return String(index + 1).padStart(12, "0");
		});
	});
	http.mockError(capacityError({ blocker: refs.join(", ") }));
	for (let round = 0; round < rounds; round += 1) {
		for (const path of refs) {
			http.mockResponse({
				body: { createTime: timestamp, path, state: "PROCESSING" },
				status: 200,
			});
		}
	}
}

async function submitThroughCapacityAsync(http: FakeHttpClient): Promise<unknown> {
	const submission = makeSubmission(http, {
		capacityWaitAsync: scaledAdmissionSleepAsync,
		sleep: scaledAdmissionSleepAsync,
	});
	return submitScriptAsync(submission, {
		submitBudget: 90_000,
		submitCapacityBudget: 405_000,
		timeout: 15_000,
	}).catch((err: unknown) => err);
}

function countPosts(http: FakeHttpClient): number {
	return http.requests.filter(({ request }) => request.method === "POST").length;
}

function makeRespondingSubmission(): { http: FakeHttpClient; submission: TaskSubmission } {
	useClock();
	const http = createFakeHttpClient();
	const send = http.request.bind(http);
	vi.spyOn(http, "request").mockImplementation(async (request, config) => {
		acceptTask(http);
		return send(request, config);
	});
	return { http, submission: makeSubmission(http, { sleep: sleepAsync }) };
}

function makeQuotaGatedSubmission(): { http: FakeHttpClient; submission: TaskSubmission } {
	useClock();
	const http = createFakeHttpClient();
	http.mockResponse({
		body: ACCEPTED,
		headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "600" },
		status: 200,
	});
	return { http, submission: makeSubmission(http, { sleep: sleepAsync }) };
}

async function expectInactivityExpiryAsync(submission: TaskSubmission): Promise<void> {
	const settled = vi.fn<(value: unknown) => void>();
	const observed = submitScriptAsync(submission, BUDGETED).catch(settled);
	await vi.advanceTimersByTimeAsync(149_999);

	expect(settled).not.toHaveBeenCalled();

	await vi.advanceTimersByTimeAsync(1);
	await observed;

	expect(settled).toHaveBeenCalledExactlyOnceWith(
		expect.objectContaining({ message: expect.stringContaining("90s inactivity limit") }),
	);
}

describe(TaskSubmission, () => {
	it("should submit the pinned version with its binary input and task timeout", async () => {
		expect.assertions(3);

		const http = createFakeHttpClient();
		acceptTask(http);

		await expect(
			submitScriptAsync(makeSubmission(http), {
				binaryInput: "universes/123/luau-execution-session-task-binary-inputs/input-1",
				placeVersion: 99,
			}),
		).resolves.toMatchObject({ ref: { taskId: "task-1" }, state: "QUEUED" });

		const { request } = http.requests[0]!;

		expect(request.url).toContain("/places/456/versions/99/luau-execution-session-tasks");
		expect(submitBodySchema.assert(request.body)).toStrictEqual({
			binaryInput: "universes/123/luau-execution-session-task-binary-inputs/input-1",
			script: "return 1",
			timeout: "30s",
		});
	});

	it("should submit against head with no binary input when the caller names neither", async () => {
		expect.assertions(2);

		const http = createFakeHttpClient();
		acceptTask(http);
		await submitScriptAsync(makeSubmission(http));

		const { request } = http.requests[0]!;

		expect(request.url).not.toContain("/versions/");
		expect(submitBodySchema.assert(request.body)).not.toHaveProperty("binaryInput");
	});

	it("should fail rather than resubmit when the submit body arrives short", async () => {
		expect.assertions(2);

		const http = createFakeHttpClient();
		http.mockError(
			new ApiError("Failed to parse response body (application/json, 412 chars read)", {
				statusCode: 200,
				unparsedBodyLength: 412,
			}),
		);

		await expect(submitScriptAsync(makeSubmission(http))).rejects.toThrow(
			/Failed to parse response body/,
		);
		expect(http.requests).toHaveLength(1);
	});

	it("should throw when submit returns API error", async () => {
		expect.assertions(3);

		const http = createFakeHttpClient();
		http.mockApiError({ message: "Bad request", statusCode: 400 });

		const caught: unknown = await submitScriptAsync(makeSubmission(http)).catch(
			(err: unknown) => err,
		);
		assert(caught instanceof Error);

		expect(caught).toMatchObject({ name: "TaskSubmitError" });
		expect(caught.message).toBe("Bad request");
		expect(caught.cause).toBeInstanceOf(OpenCloudError);
	});
});

describe("unbudgeted creates", () => {
	it("should not retry a task submit server failure by default", async () => {
		expect.assertions(2);

		const http = createFakeHttpClient();
		http.mockError(new ApiError("HTTP 500: unknown exception", { statusCode: 500 }));
		acceptTask(http);

		await expect(submitScriptAsync(makeSubmission(http))).rejects.toMatchObject({
			name: "TaskSubmitError",
		});
		expect(http.requests).toHaveLength(1);
	});

	it.for([
		{ body: "top-level", error: capacityError },
		{
			body: "missing",
			error: () => {
				return new RateLimitError("Rate limited", {
					retryAfterSeconds: 0,
					statusCode: 429,
				});
			},
		},
		{
			body: "nested",
			error: () => {
				return new RateLimitError("Rate limited", {
					details: {
						error: { code: "RESOURCE_EXHAUSTED", message: "Too many tasks" },
					},
					remaining: 3,
					retryAfterSeconds: 0,
					statusCode: 429,
				});
			},
		},
	])(
		"should not retry or wait out a create dmaas refused with a $body code",
		async ({ error }) => {
			expect.assertions(2);

			const http = createFakeHttpClient();
			http.mockError(error());
			acceptTask(http);

			await expect(submitScriptAsync(makeSubmission(http))).rejects.toMatchObject({
				name: "TaskQuotaError",
			});
			expect(http.requests).toHaveLength(1);
		},
	);

	it("should retry a task create the edge rate limit refused after its retry-after", async () => {
		expect.assertions(3);

		useClock();
		const http = createFakeHttpClient();
		http.mockError(
			new RateLimitError("Rate limited", {
				details: { errors: [{ code: 0, message: "" }] },
				remaining: 0,
				retryAfterSeconds: 5,
				statusCode: 429,
			}),
		);
		acceptTask(http);

		// ocale's default sleep sits on timers vitest does not fake.
		const submitted = submitScriptAsync(makeSubmission(http, { sleep: fakeTimerSleepAsync }));
		await vi.advanceTimersByTimeAsync(4999);

		expect(http.requests).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(60_000);

		await expect(submitted).resolves.toMatchObject({ ref: { taskId: "task-1" } });
		expect(http.requests).toHaveLength(2);
	});

	it("should stop waiting out an edge refusal when the caller aborts", async () => {
		expect.assertions(3);

		useClock();
		const http = createFakeHttpClient();
		http.mockError(
			new RateLimitError("Rate limited", {
				details: { errors: [{ code: 0, message: "" }] },
				retryAfterSeconds: 5,
				statusCode: 429,
			}),
		);
		const observation = new AbortController();
		const submitted = submitScriptAsync(makeSubmission(http, {}), {
			observationSignal: observation.signal,
		}).catch((err: unknown) => err);
		await vi.advanceTimersByTimeAsync(1000);
		observation.abort(new Error("superseded"));

		await expect(submitted).resolves.toMatchObject({ name: "TaskSubmitError" });
		expect(http.requests).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("should refuse at once an edge retry-after the task deadline cannot fit", async () => {
		expect.assertions(2);

		useClock();
		const http = createFakeHttpClient();
		http.mockError(
			new RateLimitError("Rate limited", {
				details: { errors: [{ code: 0, message: "" }] },
				responseHeaders: { "retry-after": "1856" },
				retryAfterSeconds: 1856,
				statusCode: 429,
			}),
		);
		let settled: unknown;
		void submitScriptAsync(makeSubmission(http, {})).catch((err: unknown) => {
			settled = err;
		});
		await vi.advanceTimersByTimeAsync(0);

		assert(settled instanceof Error);

		expect(settled.message).toMatch(/would wait 1856s; 75s remain\n {2}retry-after: 1856$/);
		expect(http.requests).toHaveLength(1);
	});

	it("should retry a task submit server failure when explicitly idempotent", async () => {
		expect.assertions(2);

		const http = createFakeHttpClient();
		http.mockError(new ApiError("HTTP 500: unknown exception", { statusCode: 500 }));
		acceptTask(http);

		await expect(
			submitScriptAsync(makeSubmission(http), { isSubmitIdempotent: true }),
		).resolves.toMatchObject({ ref: { taskId: "task-1" } });
		expect(http.requests).toHaveLength(2);
	});

	it("should abort an idempotent task submit while waiting to retry", async () => {
		expect.assertions(3);

		const controller = new AbortController();
		const http = createFakeHttpClient();
		http.mockError(new ApiError("HTTP 503: unavailable", { statusCode: 503 }));
		const submission = makeSubmission(http, {});
		useClock();

		const submitted = submitScriptAsync(submission, {
			isSubmitIdempotent: true,
			observationSignal: controller.signal,
		}).catch((err: unknown) => err);
		await vi.advanceTimersByTimeAsync(0);

		expect(http.requests).toHaveLength(1);

		controller.abort(new Error("stop retrying"));
		await vi.runAllTimersAsync();

		await expect(submitted).resolves.toBeInstanceOf(Error);

		expect(http.requests).toHaveLength(1);
	});

	it("should retry luau task submit on transient ECONNRESET", async () => {
		expect.assertions(2);

		const http = createFakeHttpClient();
		const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
		http.mockNetworkError({ cause: reset });
		acceptTask(http);

		await expect(submitScriptAsync(makeSubmission(http))).resolves.toMatchObject({
			ref: { taskId: "task-1" },
		});
		expect(http.requests).toHaveLength(2);
	});

	it("should surface one ambiguous submit transport failure when retries are disabled", async () => {
		expect.assertions(4);

		const http = createFakeHttpClient();
		const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
		http.mockNetworkError({ cause: reset });
		acceptTask(http);

		const caught: unknown = await submitScriptAsync(makeSubmission(http), {
			retrySubmitTransportErrors: false,
		}).catch((err: unknown) => err);
		assert(caught instanceof Error);

		expect(caught).toMatchObject({ name: "TaskSubmitError" });
		expect(caught.cause).toBeInstanceOf(NetworkError);
		expect(caught.cause).toMatchObject({ cause: reset });
		expect(http.requests).toHaveLength(1);
	});

	it("should stop resending edge refusals at the configured retry count", async () => {
		expect.assertions(3);

		const http = createFakeHttpClient();
		for (let attempt = 0; attempt < 3; attempt += 1) {
			http.mockError(
				new RateLimitError("edge refused", {
					details: { errors: [] },
					retryAfterSeconds: 1,
				}),
			);
		}

		acceptTask(http);
		const sleep = createFakeSleep();

		await expect(
			submitScriptAsync(makeSubmission(http, { maxRetries: 2, sleep })),
		).rejects.toMatchObject({ name: "TaskQuotaError" });
		expect(http.requests).toHaveLength(3);
		expect(sleep.waits).toStrictEqual([1000, 1000]);
	});

	it("should retain the SDK retry count for an unbudgeted idempotent create", async () => {
		expect.assertions(2);

		const http = createFakeHttpClient();
		http.mockApiError({ message: "first refusal", statusCode: 503 });
		http.mockApiError({ message: "second refusal", statusCode: 503 });
		acceptTask(http);

		await expect(
			submitScriptAsync(makeSubmission(http, { maxRetries: 1, sleep: createFakeSleep() }), {
				isSubmitIdempotent: true,
			}),
		).rejects.toMatchObject({ name: "TaskSubmitError" });
		expect(http.requests).toHaveLength(2);
	});
});

describe("quota refusals", () => {
	it("should preserve the server diagnosis when active tasks exhaust the place", async () => {
		expect.assertions(2);

		const http = createFakeHttpClient();
		const exhausted = new RateLimitError("Rate limited", {
			details: {
				code: "RESOURCE_EXHAUSTED",
				message: "Too many tasks already active. Task resource paths: task/one, task/two",
			},
			retryAfterSeconds: 3,
			statusCode: 429,
		});
		for (let attempt = 0; attempt < 4; attempt += 1) {
			http.mockError(exhausted);
		}

		const caught: unknown = await submitScriptAsync(makeSubmission(http)).catch(
			(err: unknown) => err,
		);
		assert(caught instanceof Error);

		expect(caught.message).toBe(
			"RESOURCE_EXHAUSTED: Too many tasks already active. Task resource paths: task/one, task/two",
		);
		expect(caught.cause).toBe(exhausted);
	});

	it("should name the 429's code and rate-limit headers when dmaas refuses a create", async () => {
		expect.assertions(1);

		const http = createFakeHttpClient();
		http.mockError(
			new RateLimitError("Rate limited", {
				code: "RESOURCE_EXHAUSTED",
				details: { code: "RESOURCE_EXHAUSTED", message: "Too many tasks" },
				responseHeaders: {
					"retry-after": "3",
					"x-ratelimit-limit": "5, 5;w=60",
					"x-ratelimit-remaining": "0",
				},
				retryAfterSeconds: 3,
				statusCode: 429,
			}),
		);

		await expect(submitScriptAsync(makeSubmission(http))).rejects.toThrow(
			[
				"RESOURCE_EXHAUSTED: Too many tasks",
				"  code: RESOURCE_EXHAUSTED",
				"  retry-after: 3",
				"  x-ratelimit-limit: 5, 5;w=60",
				"  x-ratelimit-remaining: 0",
			].join("\n"),
		);
	});

	it("should name the unlock time when a refusal outlasts the minute window", async () => {
		expect.assertions(2);

		vi.useFakeTimers({ now: new Date("2026-09-22T12:00:51Z") });
		onTestFinished(() => {
			vi.useRealTimers();
		});
		const http = createFakeHttpClient();
		http.mockError(
			new RateLimitError("Rate limited", {
				details: {
					code: "RESOURCE_EXHAUSTED",
					message: "dmaas (Too Many Requests)",
				},
				retryAfterSeconds: 1856,
				statusCode: 429,
			}),
		);

		const caught: unknown = await submitScriptAsync(makeSubmission(http)).catch(
			(err: unknown) => err,
		);
		assert(caught instanceof Error);

		expect(caught.message).toContain(
			"Roblox refused task creates for longer than its per-minute limit; " +
				"this account can create tasks again at 2026-09-22T12:31:47Z.",
		);
		expect(http.requests).toHaveLength(1);
	});

	it("should not observe capacity blockers when retries are disabled", async () => {
		expect.assertions(2);

		const http = createFakeHttpClient();
		http.mockError(
			new RateLimitError("Rate limited", {
				details: {
					code: "RESOURCE_EXHAUSTED",
					message: `Too many tasks already active. Task resource paths: ${CAPACITY_BLOCKER}`,
				},
				retryAfterSeconds: 3,
				statusCode: 429,
			}),
		);

		await expect(
			submitScriptAsync(makeSubmission(http, { maxRetries: 0, sleep: createFakeSleep() })),
		).rejects.toThrow("RESOURCE_EXHAUSTED");
		expect(http.requests).toHaveLength(1);
	});

	it("should classify a create the quota refused, with its unlock time and 429 evidence", async () => {
		expect.assertions(1);

		vi.useFakeTimers({ now: new Date("2026-09-22T12:00:51Z") });
		onTestFinished(() => {
			vi.useRealTimers();
		});
		const http = createFakeHttpClient();
		http.mockError(
			new RateLimitError("Rate limited", {
				code: "RESOURCE_EXHAUSTED",
				details: { code: "RESOURCE_EXHAUSTED", message: "dmaas (Too Many Requests)" },
				responseHeaders: { "retry-after": "1856", "x-ratelimit-remaining": "3" },
				retryAfterSeconds: 1856,
				statusCode: 429,
			}),
		);

		const caught: unknown = await submitScriptAsync(makeSubmission(http), {
			placeVersion: 7,
		}).catch((err: unknown) => err);
		assert(caught instanceof Error);

		expect(fromAny<TaskQuotaError, typeof caught>(caught).evidence).toStrictEqual({
			code: "RESOURCE_EXHAUSTED",
			headers: { "retry-after": "1856", "x-ratelimit-remaining": "3" },
			kind: "create-quota",
			placeVersion: 7,
			retryAfterSeconds: 1856,
			timeoutSeconds: 30,
			unlockTime: "2026-09-22T12:31:47.000Z",
		});
	});

	it("should classify a refused long 429 wait on an idempotent submit as a quota error", async () => {
		expect.assertions(2);

		vi.useFakeTimers({ now: new Date("2026-09-22T12:00:51Z") });
		onTestFinished(() => {
			vi.useRealTimers();
		});
		const http = createFakeHttpClient();
		http.mockError(
			new RateLimitError("Rate limited", {
				code: "RESOURCE_EXHAUSTED",
				details: { code: "RESOURCE_EXHAUSTED", message: "dmaas (Too Many Requests)" },
				responseHeaders: { "retry-after": "515" },
				retryAfterSeconds: 515,
				statusCode: 429,
			}),
		);

		const caught: unknown = await submitScriptAsync(makeSubmission(http), {
			isSubmitIdempotent: true,
			placeVersion: 7,
		}).catch((err: unknown) => err);
		assert(caught instanceof Error);

		expect(fromAny<TaskQuotaError, typeof caught>(caught).evidence).toStrictEqual({
			code: "RESOURCE_EXHAUSTED",
			headers: { "retry-after": "515" },
			kind: "create-quota",
			placeVersion: 7,
			retryAfterSeconds: 515,
			timeoutSeconds: 30,
			unlockTime: "2026-09-22T12:09:26.000Z",
		});
		expect(http.requests).toHaveLength(1);
	});

	it("should remove the API key from a quota refusal's evidence and message", async () => {
		expect.assertions(2);

		const http = createFakeHttpClient();
		http.mockError(
			new RateLimitError("Rate limited", {
				details: { code: "RESOURCE_EXHAUSTED", message: "Too many tasks for test-key" },
				responseHeaders: { "retry-after": "3", "x-roblox-echo": "key=test-key" },
				retryAfterSeconds: 3,
				statusCode: 429,
			}),
		);

		const caught: unknown = await submitScriptAsync(makeSubmission(http)).catch(
			(err: unknown) => err,
		);
		assert(caught instanceof Error);

		expect(fromAny<TaskQuotaError, typeof caught>(caught).evidence.headers).toStrictEqual({
			"retry-after": "3",
			"x-roblox-echo": "key=[REDACTED]",
		});
		expect(caught.message).not.toContain("test-key");
	});
});

describe("budgeted creates", () => {
	it("should fail a budgeted submit that never answers", async () => {
		expect.assertions(2);

		// Nothing queued and nothing returned: the shape of a submit parked
		// in rate-limit backoff, which is what the budget exists to end.
		useClock();
		const stalled = createFakeHttpClient();
		const submit = vi
			.spyOn(stalled, "request")
			.mockImplementation(async () => new Promise(() => {}));

		const submitted = submitScriptAsync(makeSubmission(stalled), { submitBudget: 1000 }).catch(
			(err: unknown) => err,
		);
		await vi.advanceTimersByTimeAsync(1000);

		await expect(submitted).resolves.toMatchObject({
			message: expect.stringContaining("Open Cloud did not accept the task within 1s"),
		});
		expect(submit.mock.calls[0]![1].signal!.reason).toBe("submit budget expired");
	});

	it("should report capacity-aware inactivity and maximum bounds", async () => {
		expect.assertions(1);

		const stalled = createFakeHttpClient();
		vi.spyOn(stalled, "request").mockImplementation(async () => new Promise(() => {}));

		await expect(
			submitScriptAsync(makeSubmission(stalled), {
				submitBudget: 10,
				submitCapacityBudget: 20,
			}),
		).rejects.toThrow("0s inactivity limit; 0s maximum");
	});

	it.for([false, true])(
		"should retry rate limits with idempotent=%s when submit transport retries are disabled",
		async (isSubmitIdempotent) => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			// Six unguided 429s outlast ocale's default (maxRetries 3), so
			// only a budget-bounded submit reaches the response behind them.
			for (let index = 0; index < 6; index += 1) {
				http.mockRateLimit({ message: "Rate limited", retryAfterSeconds: 0 });
			}

			acceptTask(http);

			await expect(
				submitScriptAsync(makeSubmission(http), {
					isSubmitIdempotent,
					retrySubmitTransportErrors: false,
					submitBudget: 60_000,
				}),
			).resolves.toMatchObject({ ref: { taskId: "task-1" } });
		},
	);

	it("should keep budgeted creates on the raw transport when the caller disables capacity retries", async () => {
		expect.assertions(2);

		const http = createFakeHttpClient();
		for (let attempt = 0; attempt < 33; attempt += 1) {
			http.mockError(capacityError({ retryAfterSeconds: 0 }));
		}

		await expect(
			submitScriptAsync(makeSubmission(http, { maxRetries: 0, sleep: createFakeSleep() }), {
				submitBudget: 1000,
			}),
		).rejects.toMatchObject({ name: "TaskQuotaError" });
		expect(http.requests.map(({ request }) => request.method)).toStrictEqual(
			Array.from<"POST">({ length: 33 }).fill("POST"),
		);
	});
});

describe("capacity admission", () => {
	it("should admit after ten unchanged occupants complete their 300 second runtime", async () => {
		expect.assertions(3);

		useClock();

		const http = createFakeHttpClient();
		for (let cycle = 0; cycle < 4; cycle += 1) {
			queueOccupiedPlace(http, 12);
		}

		queueOccupiedPlace(http, 8);
		http.mockResponse({ body: { state: "COMPLETE" }, status: 200 });
		acceptTask(http);
		const submitted = submitThroughCapacityAsync(http);
		await vi.advanceTimersByTimeAsync(306_000);

		await expect(submitted).resolves.toMatchObject({ ref: { taskId: "task-1" } });
		expect(countPosts(http)).toBe(6);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("should stop permanently occupied capacity at the 495 second absolute cap", async () => {
		expect.assertions(3);

		useClock();

		const http = createFakeHttpClient();
		for (let cycle = 0; cycle < 8; cycle += 1) {
			queueOccupiedPlace(http, 12);
		}

		const submitted = submitThroughCapacityAsync(http);
		await vi.advanceTimersByTimeAsync(495_000);

		await expect(submitted).resolves.toMatchObject({
			message: expect.stringContaining("495s maximum"),
		});
		expect(countPosts(http)).toBe(8);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("should isolate concurrent capacity submit cancellation on one submission", async () => {
		// eslint-disable-next-line flawless/prefer-expect-assertions-count -- waitFor may retry its assertions
		expect.hasAssertions();

		const http = createFakeHttpClient();
		http.mockError(capacityError());
		http.mockResponse({ body: { state: "PROCESSING" }, status: 200 });
		const submission = makeSubmission(http, {
			capacityWaitAsync: async (_ms, signal) => {
				await new Promise<void>((_resolve, reject) => {
					signal!.addEventListener(
						"abort",
						() => {
							reject(new Error("capacity wait aborted", { cause: signal!.reason }));
						},
						{ once: true },
					);
				});
			},
		});
		const firstController = new AbortController();
		const secondController = new AbortController();
		let isSecondSettled = false;
		const first = submitScriptAsync(submission, {
			observationSignal: firstController.signal,
			submitBudget: 75_000,
			submitCapacityBudget: 405_000,
		}).catch((err: unknown) => err);
		await vi.waitFor(() => {
			expect(http.requests.filter(({ request }) => request.method === "GET")).toHaveLength(1);
		});
		http.mockError(capacityError());
		http.mockResponse({ body: { state: "PROCESSING" }, status: 200 });
		const second = submitScriptAsync(submission, {
			observationSignal: secondController.signal,
			script: "return 2",
			submitBudget: 75_000,
			submitCapacityBudget: 405_000,
		})
			.then((value) => {
				isSecondSettled = true;
				return value;
			})
			.catch((err: unknown) => {
				isSecondSettled = true;
				return err;
			});
		await vi.waitFor(() => {
			expect(countPosts(http)).toBe(2);
		});
		firstController.abort(new Error("stop first"));

		await expect(first).resolves.toMatchObject({
			cause: { reason: { message: "stop first" } },
		});
		expect(isSecondSettled).toBeFalse();

		secondController.abort(new Error("stop second"));

		await expect(second).resolves.toMatchObject({
			cause: { reason: { message: "stop second" } },
		});
	});

	it("should admit after a validated capacity blocker completes", async () => {
		expect.assertions(2);

		const http = createFakeHttpClient();
		http.mockError(capacityError({ retryAfterSeconds: 1 }));
		http.mockResponse({ body: { state: "COMPLETE" }, status: 200 });
		http.mockError(capacityError({ retryAfterSeconds: 1 }));
		http.mockResponse({ body: { state: "COMPLETE" }, status: 200 });
		acceptTask(http);

		await expect(
			submitScriptAsync(makeSubmission(http), {
				submitBudget: 1000,
				submitCapacityBudget: 1000,
			}),
		).resolves.toMatchObject({ ref: { taskId: "task-1" } });

		http.mockError(capacityError({ retryAfterSeconds: 1 }));
		http.mockResponse({ body: { state: "COMPLETE" }, status: 200 });
		acceptTask(http);

		await expect(
			submitScriptAsync(makeSubmission(http), { submitBudget: 1000 }),
		).resolves.toMatchObject({ ref: { taskId: "task-1" } });
	});

	it("should preserve a progressing capacity submit past its inactivity budget", async () => {
		expect.assertions(2);

		useClock();

		const http = createFakeHttpClient();
		http.mockError(capacityError());
		for (let cycle = 0; cycle < 3; cycle += 1) {
			http.mockResponse({ body: { state: "PROCESSING" }, status: 200 });
		}

		http.mockResponse({ body: { state: "COMPLETE" }, status: 200 });
		http.mockError(
			new RateLimitError("Rate limited", {
				remaining: 0,
				retryAfterSeconds: 60,
				statusCode: 429,
			}),
		);
		acceptTask(http);
		const submission = makeSubmission(http, {
			capacityWaitAsync: fakeTimerSleepAsync,
			sleep: scaledAdmissionSleepAsync,
		});
		let isSettled = false;
		const submitted = submitScriptAsync(submission, {
			submitBudget: 75_000,
			submitCapacityBudget: 405_000,
		})
			.then((task) => {
				isSettled = true;
				return { outcome: "fulfilled" as const, task };
			})
			.catch((err: unknown) => {
				isSettled = true;
				return { err, outcome: "rejected" as const };
			});

		for (let elapsed = 0; elapsed < 70_000; elapsed += 5000) {
			await vi.advanceTimersByTimeAsync(5000);
		}

		expect(isSettled).toBeFalse();

		for (let elapsed = 0; elapsed < 15_000; elapsed += 5000) {
			await vi.advanceTimersByTimeAsync(5000);
		}

		await vi.runOnlyPendingTimersAsync();

		await expect(submitted).resolves.toMatchObject({
			outcome: "fulfilled",
			task: { ref: { taskId: "task-1" } },
		});
	});

	it("should renew inactivity after a slow blocker read before SDK retry delay", async () => {
		expect.assertions(2);

		useClock();
		const http = createFakeHttpClient();
		http.mockError(
			new RateLimitError("occupied", {
				details: {
					code: "RESOURCE_EXHAUSTED",
					message: `Too many tasks: ${CAPACITY_BLOCKER}`,
				},
				remaining: 3,
				retryAfterSeconds: 1,
			}),
		);
		http.mockResponse({ body: { state: "COMPLETE" }, status: 200 });
		acceptTask(http);
		const send = http.request.bind(http);
		vi.spyOn(http, "request")
			.mockImplementationOnce(send)
			.mockImplementationOnce(async (request, config) => {
				await sleepAsync(1500, config.signal);
				return send(request, config);
			});
		const submitted = submitScriptAsync(makeSubmission(http, { sleep: sleepAsync }), {
			submitBudget: 2000,
			submitCapacityBudget: 5000,
		}).catch((err: unknown) => err);
		await vi.advanceTimersByTimeAsync(3000);

		await expect(submitted).resolves.toMatchObject({ ref: { taskId: "task-1" } });
		expect(http.requests).toHaveLength(3);
	});
});

describe("the SDK admission waits", () => {
	it("should exclude time behind other submissions in the static create queue", async () => {
		expect.assertions(3);

		const { http, submission } = makeRespondingSubmission();
		const submitted = Array.from({ length: 14 }, async () => {
			return submitScriptAsync(submission, BUDGETED).catch((err: unknown) => err);
		});
		await vi.advanceTimersByTimeAsync(110_000);

		await expect(Promise.all(submitted)).resolves.toStrictEqual(
			Array.from({ length: 14 }, () => expect.objectContaining({ state: "QUEUED" })),
		);
		expect(countPosts(http)).toBe(14);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("should cancel a queued caller without consuming a later submit slot", async () => {
		expect.assertions(4);

		const { http, submission } = makeRespondingSubmission();
		const active = Array.from({ length: 13 }, async () => {
			return submitScriptAsync(submission, BUDGETED);
		});
		const controller = new AbortController();
		const canceled = submitScriptAsync(submission, {
			...BUDGETED,
			observationSignal: controller.signal,
		}).catch((err: unknown) => err);
		await vi.advanceTimersByTimeAsync(1000);
		controller.abort("no longer needed");

		await expect(canceled).resolves.toMatchObject({ cause: { reason: "no longer needed" } });

		await vi.advanceTimersByTimeAsync(99_000);

		await expect(Promise.all(active)).resolves.toHaveLength(13);
		expect(countPosts(http)).toBe(13);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("should exclude a successful response's quota wait before the next HTTP request", async () => {
		expect.assertions(3);

		useClock();
		const http = createFakeHttpClient();
		http.mockResponse({
			body: ACCEPTED,
			headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "60" },
			status: 200,
		});
		acceptTask(http);
		const send = http.request.bind(http);
		vi.spyOn(http, "request")
			.mockImplementationOnce(send)
			.mockImplementationOnce(async (request, config) => {
				await sleepAsync(40_000);
				return send(request, config);
			});
		const submission = makeSubmission(http, { sleep: sleepAsync });
		await submitScriptAsync(submission, BUDGETED);
		const submitted = submitScriptAsync(submission, BUDGETED).catch((err: unknown) => err);
		await vi.advanceTimersByTimeAsync(59_999);

		expect(http.requests).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(40_001);

		await expect(submitted).resolves.toMatchObject({ ref: { taskId: "task-1" } });
		expect(http.requests).toHaveLength(2);
	});

	it("should charge a stalled HTTP request after a quota gate against inactivity", async () => {
		expect.assertions(3);

		useClock();
		const http = createFakeHttpClient();
		http.mockResponse({
			body: ACCEPTED,
			headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "60" },
			status: 200,
		});
		const send = http.request.bind(http);
		vi.spyOn(http, "request")
			.mockImplementationOnce(send)
			.mockImplementationOnce(async () => new Promise(() => {}));
		const submission = makeSubmission(http, { sleep: sleepAsync });
		await submitScriptAsync(submission, BUDGETED);
		await expectInactivityExpiryAsync(submission);

		expect(vi.getTimerCount()).toBe(0);
	});

	it("should cancel both a sleeping quota gate and its queued follower immediately", async () => {
		expect.assertions(4);

		const { http, submission } = makeQuotaGatedSubmission();
		await submitScriptAsync(submission, BUDGETED);
		const first = new AbortController();
		const second = new AbortController();
		const firstResult = submitScriptAsync(submission, {
			...BUDGETED,
			observationSignal: first.signal,
		}).catch((err: unknown) => err);
		const secondResult = submitScriptAsync(submission, {
			...BUDGETED,
			observationSignal: second.signal,
		}).catch((err: unknown) => err);
		await vi.advanceTimersByTimeAsync(1000);
		second.abort("follower stopped");

		await expect(secondResult).resolves.toMatchObject({
			cause: { reason: "follower stopped" },
		});

		first.abort("first stopped");

		await expect(firstResult).resolves.toMatchObject({ cause: { reason: "first stopped" } });
		expect(http.requests).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("should not excuse an SDK wait when no capacity budget was granted", async () => {
		expect.assertions(3);

		const { http, submission } = makeQuotaGatedSubmission();
		const { submitCapacityBudget, ...inactivityOnly } = BUDGETED;
		await submitScriptAsync(submission, inactivityOnly);
		const settled = vi.fn<(value: unknown) => void>();
		const submitted = submitScriptAsync(submission, inactivityOnly).catch(settled);
		await vi.advanceTimersByTimeAsync(89_999);

		expect(settled).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		await submitted;

		expect(settled).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				message: expect.stringContaining("did not accept the task within 90s"),
			}),
		);
		expect(http.requests).toHaveLength(1);
	});

	it("should not credit a quota retry again when it crosses the SDK gate", async () => {
		expect.assertions(3);

		useClock();
		const http = createFakeHttpClient();
		http.mockError(new RateLimitError("quota", { remaining: 0, retryAfterSeconds: 60 }));
		const send = http.request.bind(http);
		vi.spyOn(http, "request")
			.mockImplementationOnce(send)
			.mockImplementationOnce(async () => new Promise(() => {}));
		await expectInactivityExpiryAsync(makeSubmission(http, { sleep: sleepAsync }));

		expect(vi.getTimerCount()).toBe(0);
	});
});
