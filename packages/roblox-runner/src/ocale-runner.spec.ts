import { ApiError, NetworkError, OpenCloudError, PollTimeoutError } from "@bedrock-rbx/ocale";
import {
	createFakeHttpClient,
	createFakeSleep,
	type FakeHttpClient,
	validBinaryInputBody,
} from "@bedrock-rbx/ocale/testing";
import { fromAny } from "@total-typescript/shoehorn";

import { type } from "arktype";
import buffer from "node:buffer";
import { assert, describe, expect, it, vi } from "vitest";

import { ExecutionTimeoutError } from "./execution-timeout.ts";
import { OcaleRunner } from "./ocale-runner.ts";
import type { ScriptResult } from "./types.ts";

const RBXL_SIGNATURE = new Uint8Array([
	0x3c, 0x72, 0x6f, 0x62, 0x6c, 0x6f, 0x78, 0x21, 0x89, 0xff, 0x0d, 0x0a, 0x1a, 0x0a,
]);

interface TaskBodyOverrides {
	error?: { code: string; message: string };
	output?: { results: ReadonlyArray<unknown> };
	path?: string;
	state?: "CANCELLED" | "COMPLETE" | "FAILED" | "PROCESSING" | "QUEUED";
}

interface TaskBody {
	createTime: string;
	error?: { code: string; message: string };
	output?: { results: ReadonlyArray<unknown> };
	path: string;
	state: "CANCELLED" | "COMPLETE" | "FAILED" | "PROCESSING" | "QUEUED";
	updateTime: string;
	user: string;
}

function taskBody(overrides: TaskBodyOverrides = {}): TaskBody {
	const body: TaskBody = {
		createTime: "2026-01-01T00:00:00Z",
		path:
			overrides.path ??
			"universes/123/places/456/versions/1/luau-execution-sessions/session-1/tasks/task-1",
		state: overrides.state ?? "QUEUED",
		updateTime: "2026-01-01T00:00:30Z",
		user: "user-1",
	};
	if (overrides.error !== undefined) {
		body.error = overrides.error;
	}

	if (overrides.output !== undefined) {
		body.output = overrides.output;
	}

	return body;
}

const submitBodySchema = type({ timeout: "string" });
const binaryInputSubmitSchema = type({ "binaryInput?": "string" });
const createBodySchema = type({ size: "number" });

const INPUT_PATH = "universes/123/luau-execution-session-task-binary-inputs/input-1";
const UPLOAD_URI = "https://upload.example/slot-1";

/** One PUT the runner would issue, as the fake `fetch` saw it. */
interface FetchCall {
	body: Uint8Array;
	method: string;
	url: string;
}

/**
 * A `fetch` that answers every call with one status and records what it was
 * handed, so a spec can assert on the presigned PUT without a server.
 */
function makeFakeFetch(
	status: number,
	text = "",
): { calls: Array<FetchCall>; fetchFn: typeof globalThis.fetch } {
	const calls: Array<FetchCall> = [];
	return {
		calls,
		fetchFn: fromAny(async (url: string, init: { body: Uint8Array; method: string }) => {
			calls.push({ body: init.body, method: init.method, url });
			return new Response(text, { status });
		}),
	};
}

/**
 * Poll cadence ocale applies below 20s elapsed. The specs below queue poll
 * responses by count, so they need the loop's own step to know how many.
 */
const POLL_STEP_MS = 500;

/** Polls the loop makes before a 10s task deadline elapses. */
const POLLS_PER_DEADLINE = 10_000 / POLL_STEP_MS;

/**
 * Polls that outlast the boot-lag grace. Generous on purpose: the cadence
 * eases off past 20s elapsed, so counting exactly would encode ocale's
 * schedule into these specs.
 */
const POLLS_PER_GRACE = 200;

function logPageBody(
	messages: ReadonlyArray<{ message: string; messageType: string }>,
): Record<string, unknown> {
	return {
		luauExecutionSessionTaskLogs: [
			{
				path: "universes/123/places/456/versions/1/luau-execution-sessions/session-1/tasks/task-1/logs/1",
				structuredMessages: messages.map((entry) => {
					return { ...entry, createTime: "2026-01-01T00:00:00Z" };
				}),
			},
		],
	};
}

function mockProcessing(http: FakeHttpClient, count: number): void {
	for (let index = 0; index < count; index += 1) {
		http.mockResponse({ body: taskBody({ state: "PROCESSING" }), status: 200 });
	}
}

function rbxlBuffer(): buffer.Buffer {
	return buffer.Buffer.from(RBXL_SIGNATURE);
}

/**
 * A runner whose sleep advances a fake clock instead of waiting, so a spec can
 * exhaust a real poll budget without spending it.
 */
function makeAdvancingRunner(http: FakeHttpClient): OcaleRunner {
	let clock = 1_000_000;
	vi.spyOn(Date, "now").mockImplementation(() => clock);
	return new OcaleRunner(
		{ apiKey: "test-key", placeId: "456", universeId: "123" },
		{
			httpClient: http,
			readFile: () => rbxlBuffer(),
			sleep: fromAny((ms: number) => {
				clock += ms;
			}),
		},
	);
}

function makeRunner(
	httpClient: FakeHttpClient,
	readData: buffer.Buffer = rbxlBuffer(),
	fetchFunc?: typeof globalThis.fetch,
) {
	return new OcaleRunner(
		{ apiKey: "test-key", placeId: "456", universeId: "123" },
		{
			...(fetchFunc === undefined ? {} : { fetch: fetchFunc }),
			httpClient,
			readFile: () => readData,
			sleep: createFakeSleep(),
		},
	);
}

describe(OcaleRunner, () => {
	describe("uploadPlace", () => {
		it("should publish rbxl place and return versionNumber", async () => {
			expect.assertions(2);

			const http = createFakeHttpClient();
			http.mockResponse({ body: { versionNumber: 7 }, status: 200 });

			const runner = makeRunner(http);
			const result = await runner.uploadPlaceAsync({ placeFilePath: "/work/test.rbxl" });

			expect(result.versionNumber).toBe(7);
			expect(http.requests[0]!.request.url).toContain("/places/456/versions");
		});

		it("should request a Saved version type by default", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockResponse({ body: { versionNumber: 1 }, status: 200 });

			const runner = makeRunner(http);
			await runner.uploadPlaceAsync({ placeFilePath: "/work/p.rbxl" });

			expect(http.requests[0]!.request.url).toContain("versionType=Saved");
		});

		it("should request a Published version type when publish is true", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockResponse({ body: { versionNumber: 1 }, status: 200 });

			const runner = makeRunner(http);
			await runner.uploadPlaceAsync({ placeFilePath: "/work/p.rbxl", publish: true });

			expect(http.requests[0]!.request.url).toContain("versionType=Published");
		});

		it("should send rbxlx format when path extension is .rbxlx", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockResponse({ body: { versionNumber: 1 }, status: 200 });

			const xmlBody = buffer.Buffer.from('<roblox version="4"></roblox>');
			const runner = makeRunner(http, xmlBody);
			await runner.uploadPlaceAsync({ placeFilePath: "/work/test.rbxlx" });

			const captured = http.requests[0]!.request;
			const headers = captured.headers!;

			expect(headers["content-type"]).toMatch(/xml/i);
		});

		it("should always upload on repeat calls with identical bytes", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockResponse({ body: { versionNumber: 1 }, status: 200 });
			http.mockResponse({ body: { versionNumber: 2 }, status: 200 });

			const runner = makeRunner(http);

			await runner.uploadPlaceAsync({ placeFilePath: "/work/p.rbxl" });
			await runner.uploadPlaceAsync({ placeFilePath: "/work/p.rbxl" });

			expect(http.requests).toHaveLength(2);
		});

		it("should throw when publish returns an API error", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockApiError({ message: "Unauthorized", statusCode: 401 });

			const runner = makeRunner(http);

			await expect(
				runner.uploadPlaceAsync({ placeFilePath: "/work/p.rbxl" }),
			).rejects.toThrow(/Unauthorized/);
		});

		it("should preserve the underlying OpenCloudError as cause on the thrown Error from uploadPlace", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockApiError({ message: "Unauthorized", statusCode: 401 });

			const runner = makeRunner(http);

			const caught: unknown = await runner
				.uploadPlaceAsync({ placeFilePath: "/work/p.rbxl" })
				.catch((err) => err);

			assert(caught instanceof Error);

			expect(caught.cause).toBeInstanceOf(OpenCloudError);
		});

		it("should retry place save on transient ECONNRESET", async () => {
			expect.assertions(2);

			const http = createFakeHttpClient();
			const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
			http.mockNetworkError({ cause: reset });
			http.mockResponse({ body: { versionNumber: 4 }, status: 200 });

			const runner = makeRunner(http);
			const result = await runner.uploadPlaceAsync({ placeFilePath: "/work/p.rbxl" });

			expect(result.versionNumber).toBe(4);
			expect(http.requests).toHaveLength(2);
		});

		it("should name the place file that failed to upload", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockApiError({ message: "Unauthorized", statusCode: 401 });

			const runner = makeRunner(http);

			await expect(
				runner.uploadPlaceAsync({ placeFilePath: "/work/nested/game.rbxl" }),
			).rejects.toThrow(/game\.rbxl/);
		});

		it("should name the failing request and its elapsed time when upload fails", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockError(
				new ApiError("HTTP 400: Invalid place file", {
					elapsedMs: 31_200,
					method: "POST",
					statusCode: 400,
					url: "https://apis.roblox.com/universes/v1/123/places/456/versions",
				}),
			);

			const runner = makeRunner(http);

			await expect(
				runner.uploadPlaceAsync({ placeFilePath: "/work/p.rbxl" }),
			).rejects.toThrow(
				"HTTP 400: Invalid place file on POST https://apis.roblox.com/universes/v1/123/places/456/versions after 31.2s",
			);
		});

		it("should name the failing request when a transport failure survives retries", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockError(
				new NetworkError("Network request failed", {
					method: "POST",
					url: "https://apis.roblox.com/universes/v1/123/places/456/versions",
				}),
			);

			const runner = makeRunner(http);

			await expect(
				runner.uploadPlaceAsync({ placeFilePath: "/work/p.rbxl" }),
			).rejects.toThrow(
				"Network request failed on POST https://apis.roblox.com/universes/v1/123/places/456/versions",
			);
		});

		it("should surface a rate limit that outlives the retry budget", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			// maxRetries defaults to 3, so a fourth 429 has no attempt left.
			http.mockRateLimit({ message: "Rate limited", retryAfterSeconds: 1 });
			http.mockRateLimit({ message: "Rate limited", retryAfterSeconds: 1 });
			http.mockRateLimit({ message: "Rate limited", retryAfterSeconds: 1 });
			http.mockRateLimit({ message: "Rate limited", retryAfterSeconds: 1 });

			const runner = makeRunner(http);

			await expect(
				runner.uploadPlaceAsync({ placeFilePath: "/work/p.rbxl" }),
			).rejects.toThrow(/Rate limited$/);
		});

		it("should retry place upload on a transient 502", async () => {
			expect.assertions(2);

			const http = createFakeHttpClient();
			http.mockApiError({ message: "Request Context Failure", statusCode: 502 });
			http.mockResponse({ body: { versionNumber: 5 }, status: 200 });

			const runner = makeRunner(http);
			const result = await runner.uploadPlaceAsync({ placeFilePath: "/work/p.rbxl" });

			expect(result.versionNumber).toBe(5);
			expect(http.requests).toHaveLength(2);
		});

		it("should retry place upload on a gateway rejection", async () => {
			expect.assertions(2);

			const http = createFakeHttpClient();
			http.mockError(
				new ApiError("HTTP 400", {
					gatewaySummary: "The requested URL could not be retrieved",
					statusCode: 400,
				}),
			);
			http.mockResponse({ body: { versionNumber: 6 }, status: 200 });

			const runner = makeRunner(http);
			const result = await runner.uploadPlaceAsync({ placeFilePath: "/work/p.rbxl" });

			expect(result.versionNumber).toBe(6);
			expect(http.requests).toHaveLength(2);
		});

		it("should honor a higher maxRetries to ride out a 429 throttle", async () => {
			expect.assertions(2);

			const http = createFakeHttpClient();
			// Four consecutive 429s exhaust the bedrock default budget
			// (maxRetries 3 = 4 attempts); maxRetries 5 grants a 5th attempt.
			http.mockApiError({ message: "Rate limited", statusCode: 429 });
			http.mockApiError({ message: "Rate limited", statusCode: 429 });
			http.mockApiError({ message: "Rate limited", statusCode: 429 });
			http.mockApiError({ message: "Rate limited", statusCode: 429 });
			http.mockResponse({ body: { versionNumber: 9 }, status: 200 });

			const runner = new OcaleRunner(
				{ apiKey: "test-key", placeId: "456", universeId: "123" },
				{
					httpClient: http,
					maxRetries: 5,
					readFile: () => rbxlBuffer(),
					sleep: createFakeSleep(),
				},
			);
			const result = await runner.uploadPlaceAsync({ placeFilePath: "/work/p.rbxl" });

			expect(result.versionNumber).toBe(9);
			expect(http.requests).toHaveLength(5);
		});
	});

	describe("executeScript", () => {
		it("should throw when timeout is not positive", async () => {
			expect.assertions(2);

			const http = createFakeHttpClient();
			const runner = makeRunner(http);

			await expect(
				runner.executeScriptAsync({ script: "return 1", timeout: 0 }),
			).rejects.toThrow("Timeout must be a positive number");
			await expect(
				runner.executeScriptAsync({ script: "return 1", timeout: -100 }),
			).rejects.toThrow("Timeout must be a positive number");
		});

		it("should fail a budgeted submit that never answers", async () => {
			expect.assertions(1);

			// Nothing queued and nothing returned: the shape of a submit parked
			// in rate-limit backoff, which is what the budget exists to end.
			const stalled = createFakeHttpClient();
			vi.spyOn(stalled, "request").mockImplementation(async () => new Promise(() => {}));
			const runner = makeRunner(stalled);

			await expect(
				runner.executeScriptAsync({
					script: "return 1",
					submitBudget: 1000,
					timeout: 30_000,
				}),
			).rejects.toThrow("Open Cloud did not accept the task within 1s");
		});

		it("should ride out more rate limits than the attempt default when budgeted", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			// Six 429s outlast ocale's create default (maxRetries 3), so only a
			// budget-bounded submit reaches the response behind them.
			for (let index = 0; index < 6; index += 1) {
				http.mockRateLimit({ message: "Rate limited", retryAfterSeconds: 1 });
			}

			http.mockResponse({ body: taskBody({ state: "QUEUED" }), status: 200 });
			http.mockResponse({
				body: taskBody({ output: { results: ["ok"] }, state: "COMPLETE" }),
				status: 200,
			});

			const runner = makeRunner(http);
			const result = await runner.executeScriptAsync({
				script: "return 1",
				submitBudget: 60_000,
				timeout: 30_000,
			});

			expect(result.outputs).toStrictEqual(["ok"]);
		});

		it("should submit, poll, and return string outputs", async () => {
			expect.assertions(3);

			const http = createFakeHttpClient();
			http.mockResponse({ body: taskBody({ state: "QUEUED" }), status: 200 });
			http.mockResponse({
				body: taskBody({
					output: { results: ["hello", "world"] },
					state: "COMPLETE",
				}),
				status: 200,
			});

			const runner = makeRunner(http);
			const result = await runner.executeScriptAsync({ script: "return 1", timeout: 30_000 });

			expect(result.outputs).toStrictEqual(["hello", "world"]);
			expect(result.durationMs).toBeGreaterThanOrEqual(0);
			expect(result.terminalTask).toMatchObject({
				ref: { sessionId: "session-1", taskId: "task-1" },
				state: "COMPLETE",
			});
		});

		it("should re-read a poll body the edge cut short", async () => {
			expect.assertions(2);

			const http = createFakeHttpClient();
			http.mockResponse({ body: taskBody({ state: "QUEUED" }), status: 200 });
			http.mockError(
				new ApiError(
					"Failed to parse response body (application/json, 1572740 chars read)",
					{
						statusCode: 200,
						unparsedBodyLength: 1_572_740,
					},
				),
			);
			http.mockResponse({
				body: taskBody({ output: { results: ["late"] }, state: "COMPLETE" }),
				status: 200,
			});

			const runner = makeRunner(http);
			const result = await runner.executeScriptAsync({ script: "return 1", timeout: 30_000 });

			expect(result.outputs).toStrictEqual(["late"]);
			expect(http.requests).toHaveLength(3);
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

			const runner = makeRunner(http);

			await expect(
				runner.executeScriptAsync({ script: "return 1", timeout: 30_000 }),
			).rejects.toThrow(/Failed to parse response body/);
			expect(http.requests).toHaveLength(1);
		});

		it("should return empty outputs when COMPLETE task has no results", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockResponse({ body: taskBody({ state: "QUEUED" }), status: 200 });
			http.mockResponse({
				body: taskBody({ output: { results: [] }, state: "COMPLETE" }),
				status: 200,
			});

			const runner = makeRunner(http);
			const result = await runner.executeScriptAsync({ script: "return 1", timeout: 30_000 });

			expect(result.outputs).toStrictEqual([]);
		});

		it("should poll through PROCESSING until COMPLETE", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockResponse({ body: taskBody({ state: "QUEUED" }), status: 200 });
			http.mockResponse({ body: taskBody({ state: "PROCESSING" }), status: 200 });
			http.mockResponse({ body: taskBody({ state: "PROCESSING" }), status: 200 });
			http.mockResponse({
				body: taskBody({ output: { results: ["done"] }, state: "COMPLETE" }),
				status: 200,
			});

			const runner = makeRunner(http);
			const result = await runner.executeScriptAsync({ script: "return 1", timeout: 30_000 });

			expect(result.outputs).toStrictEqual(["done"]);
		});

		it("should throw with task error message when task FAILS", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockResponse({ body: taskBody({ state: "QUEUED" }), status: 200 });
			http.mockResponse({
				body: taskBody({
					error: { code: "SCRIPT_ERROR", message: "Script blew up" },
					state: "FAILED",
				}),
				status: 200,
			});
			// No log page queued: the fake throws on the follow-up read, which
			// must not replace the failure being reported.

			const runner = makeRunner(http);

			await expect(
				runner.executeScriptAsync({ script: "return 1", timeout: 30_000 }),
			).rejects.toThrow("Script blew up");
		});

		it("should truncate a log line too long to belong in an error banner", async () => {
			expect.assertions(2);

			const http = createFakeHttpClient();
			http.mockResponse({ body: taskBody({ state: "QUEUED" }), status: 200 });
			http.mockResponse({
				body: taskBody({
					error: { code: "SCRIPT_ERROR", message: "boom" },
					state: "FAILED",
				}),
				status: 200,
			});
			http.mockResponse({
				body: logPageBody([{ message: "x".repeat(600), messageType: "OUTPUT" }]),
				status: 200,
			});

			const caught: unknown = await makeRunner(http)
				.executeScriptAsync({ script: "return 1", timeout: 30_000 })
				.catch((err: unknown) => err);

			assert(caught instanceof Error);

			expect(caught.message).toContain("…");
			expect(caught.message).not.toContain("x".repeat(500));
		});

		it("should pass through an API error the poll returns", async () => {
			expect.assertions(1);

			// A 404 mid-poll is authoritative — ocale stops the loop and hands
			// it back, and there is nothing to add to it.
			const http = createFakeHttpClient();
			http.mockResponse({ body: taskBody({ state: "QUEUED" }), status: 200 });
			http.mockApiError({ message: "Task not found", statusCode: 404 });

			await expect(
				makeRunner(http).executeScriptAsync({ script: "return 1", timeout: 30_000 }),
			).rejects.toThrow(/Task not found/);
		});

		it("should carry the error code, the task, and the log tail when a task FAILS", async () => {
			expect.assertions(4);

			const http = createFakeHttpClient();
			http.mockResponse({ body: taskBody({ state: "QUEUED" }), status: 200 });
			http.mockResponse({
				body: taskBody({
					error: { code: "SCRIPT_ERROR", message: "TaskScript:1: boom" },
					state: "FAILED",
				}),
				status: 200,
			});
			http.mockResponse({
				body: logPageBody([
					{ message: "starting", messageType: "OUTPUT" },
					{ message: "TaskScript:1: boom", messageType: "ERROR" },
				]),
				status: 200,
			});

			const caught: unknown = await makeRunner(http)
				.executeScriptAsync({ script: "return 1", timeout: 30_000 })
				.catch((err: unknown) => err);

			assert(caught instanceof Error);

			expect(caught.message).toContain(
				"Roblox task failed (SCRIPT_ERROR): TaskScript:1: boom",
			);
			expect(caught.message).toContain(
				"task: universes/123/places/456/versions/1/luau-execution-sessions/session-1/tasks/task-1",
			);
			expect(caught.message).toContain("[OUTPUT] starting");
			expect(caught.message).toContain("[ERROR] TaskScript:1: boom");
		});

		it("should still report the task failure when the log read fails", async () => {
			expect.assertions(2);

			const http = createFakeHttpClient();
			http.mockResponse({ body: taskBody({ state: "QUEUED" }), status: 200 });
			http.mockResponse({
				body: taskBody({
					error: { code: "SCRIPT_ERROR", message: "TaskScript:1: boom" },
					state: "FAILED",
				}),
				status: 200,
			});
			http.mockApiError({ message: "Forbidden", statusCode: 403 });

			const caught: unknown = await makeRunner(http)
				.executeScriptAsync({ script: "return 1", timeout: 30_000 })
				.catch((err: unknown) => err);

			assert(caught instanceof Error);

			expect(caught.message).toContain("Roblox task failed (SCRIPT_ERROR)");
			expect(caught.message).not.toContain("Roblox output before the failure");
		});

		it("should keep polling past the task deadline so a late FAILED is surfaced", async () => {
			expect.assertions(2);

			// Roblox starts the task deadline when the script starts running,
			// not when the task is created, so a terminal state always lands
			// after the deadline has elapsed on the host's clock. A poll budget
			// equal to the deadline reads that as a timeout and loses the error
			// Roblox wrote.
			const http = createFakeHttpClient();
			http.mockResponse({ body: taskBody({ state: "QUEUED" }), status: 200 });
			mockProcessing(http, POLLS_PER_DEADLINE + 1);
			http.mockResponse({
				body: taskBody({
					error: {
						code: "DEADLINE_EXCEEDED",
						message: "Script execution timed out.",
					},
					state: "FAILED",
				}),
				status: 200,
			});
			http.mockResponse({ body: logPageBody([]), status: 200 });

			const caught: unknown = await makeAdvancingRunner(http)
				.executeScriptAsync({ script: "return 1", timeout: 10_000 })
				.catch((err: unknown) => err);

			assert(caught instanceof Error);

			expect(caught.message).toContain("DEADLINE_EXCEEDED");
			expect(caught.message).not.toContain("Execution timed out:");
		});

		it("should name the task and its last state when polling exhausts budget", async () => {
			expect.assertions(4);

			const http = createFakeHttpClient();
			http.mockResponse({ body: taskBody({ state: "QUEUED" }), status: 200 });
			mockProcessing(http, POLLS_PER_GRACE);

			const caught: unknown = await makeAdvancingRunner(http)
				.executeScriptAsync({ script: "return 1", timeout: 1000 })
				.catch((err) => err);

			assert(caught instanceof Error);

			expect(caught.cause).toBeInstanceOf(PollTimeoutError);
			expect(caught.message).toContain(
				"universes/123/places/456/versions/1/luau-execution-sessions/session-1/tasks/task-1",
			);
			expect(caught.message).toContain("last observed state: PROCESSING");
			expect(caught.message).toContain("1s task deadline plus a 45s boot-lag allowance");
		});

		it("should cap the poll at an explicit budget, not the deadline plus grace", async () => {
			expect.assertions(3);

			// A caller that wants a wall-clock answer — "did this boot at all?" —
			// has no use for the grace, which exists so Roblox’s own verdict on a
			// running script is observable.
			const http = createFakeHttpClient();
			http.mockResponse({ body: taskBody({ state: "QUEUED" }), status: 200 });
			mockProcessing(http, POLLS_PER_GRACE);

			const caught: unknown = await makeAdvancingRunner(http)
				.executeScriptAsync({ pollBudget: 5000, script: "return 1", timeout: 300_000 })
				.catch((err: unknown) => err);

			assert(caught instanceof Error);

			expect(caught.cause).toBeInstanceOf(PollTimeoutError);
			expect(caught.message).toContain("within 5s");
			expect(caught.message).not.toContain("boot-lag allowance");
		});

		it("should not blame the place when the caller has proven it boots", async () => {
			expect.assertions(3);

			// A caller that ran a script against this version seconds ago has
			// ruled the place out already. Repeating the guess would send the
			// reader to Studio to look at a place that demonstrably loads.
			const http = createFakeHttpClient();
			http.mockResponse({ body: taskBody({ state: "QUEUED" }), status: 200 });
			mockProcessing(http, POLLS_PER_GRACE);

			const caught: unknown = await makeAdvancingRunner(http)
				.executeScriptAsync({ bootProven: true, script: "return 1", timeout: 1000 })
				.catch((err: unknown) => err);

			assert(caught instanceof Error);

			expect(caught.message).not.toContain("place version Roblox could not start");
			expect(caught.message).toContain("known to boot");
			expect(caught.message).toContain("last observed state: PROCESSING");
		});

		it("should leave execution and boot status unknown after a timeout", async () => {
			expect.assertions(2);

			const http = createFakeHttpClient();
			http.mockResponse({ body: taskBody({ state: "QUEUED" }), status: 200 });
			mockProcessing(http, POLLS_PER_GRACE);

			const caught: unknown = await makeAdvancingRunner(http)
				.executeScriptAsync({ script: "return 1", timeout: 1000 })
				.catch((err: unknown) => err);

			assert(caught instanceof Error);

			expect(caught.message).toContain("does not establish whether the script started");
			expect(caught.message).toContain(
				"Place loading, execution, or result delivery may have stalled",
			);
		});

		it.for([
			{
				body: { output: { results: ["original result", 42] }, state: "COMPLETE" },
				expected: {
					durationMs: 500,
					outputs: ["original result", "42"],
					terminalTask: {
						ref: { sessionId: "session-1", taskId: "task-1" },
						state: "COMPLETE",
					},
				},
			},
			{ body: { state: "PROCESSING" }, expected: undefined },
			{ body: { state: "QUEUED" }, expected: undefined },
		] satisfies Array<{ body: TaskBodyOverrides; expected: ScriptResult | undefined }>)(
			"should read the original task after timeout: $body.state",
			async ({ body, expected }) => {
				expect.assertions(3);

				const http = createFakeHttpClient();
				http.mockResponse({ body: taskBody(), status: 200 });
				mockProcessing(http, 1);
				const runner = makeAdvancingRunner(http);
				const caught: unknown = await runner
					.executeScriptAsync({ pollBudget: 1, script: "return 1", timeout: 1000 })
					.catch((err: unknown) => err);
				assert(caught instanceof ExecutionTimeoutError);
				http.mockResponse({ body: taskBody(body), status: 200 });
				const result = await caught.readResultAsync();

				expect(result).toStrictEqual(expected);
				expect(http.requests.map(({ request }) => request.method)).toStrictEqual([
					"POST",
					"GET",
					"GET",
				]);
				expect(http.requests[2]!.request.url).toBe(
					"/cloud/v2/universes/123/places/456/versions/1/luau-execution-sessions/session-1/tasks/task-1",
				);
			},
		);

		it("should report the original terminal failure when re-reading after timeout", async () => {
			expect.assertions(2);

			const http = createFakeHttpClient();
			http.mockResponse({ body: taskBody(), status: 200 });
			mockProcessing(http, 1);
			const caught: unknown = await makeAdvancingRunner(http)
				.executeScriptAsync({ pollBudget: 1, script: "return 1", timeout: 1000 })
				.catch((err: unknown) => err);
			assert(caught instanceof ExecutionTimeoutError);
			http.mockResponse({
				body: taskBody({
					error: { code: "SCRIPT_ERROR", message: "Original failed" },
					state: "FAILED",
				}),
				status: 200,
			});
			http.mockResponse({
				body: logPageBody([{ message: "original traceback", messageType: "ERROR" }]),
				status: 200,
			});

			await expect(caught.readResultAsync()).rejects.toThrow("original traceback");
			expect(http.requests.map(({ request }) => request.method)).toStrictEqual([
				"POST",
				"GET",
				"GET",
				"GET",
			]);
		});

		it("should report an original-task read failure without creating another task", async () => {
			expect.assertions(2);

			const http = createFakeHttpClient();
			http.mockResponse({ body: taskBody(), status: 200 });
			mockProcessing(http, 1);
			const caught: unknown = await makeAdvancingRunner(http)
				.executeScriptAsync({ pollBudget: 1, script: "return 1", timeout: 1000 })
				.catch((err: unknown) => err);
			assert(caught instanceof ExecutionTimeoutError);
			http.mockApiError({ message: "Forbidden", statusCode: 403 });

			await expect(caught.readResultAsync()).rejects.toThrow("Forbidden");
			expect(http.requests.map(({ request }) => request.method)).toStrictEqual([
				"POST",
				"GET",
				"GET",
			]);
		});

		it("should say the state is unknown when the budget outran the first poll", async () => {
			expect.assertions(2);

			// A clock that jumps a full budget between reads exhausts the poll
			// before any task body comes back, so there is no state to report.
			let clock = 1_000_000;
			vi.spyOn(Date, "now").mockImplementation(() => {
				clock += 100_000;
				return clock;
			});

			const http = createFakeHttpClient();
			http.mockResponse({ body: taskBody({ state: "QUEUED" }), status: 200 });

			const runner = new OcaleRunner(
				{ apiKey: "test-key", placeId: "456", universeId: "123" },
				{ httpClient: http, readFile: () => rbxlBuffer(), sleep: createFakeSleep() },
			);

			const caught: unknown = await runner
				.executeScriptAsync({ script: "return 1", timeout: 1000 })
				.catch((err: unknown) => err);

			assert(caught instanceof Error);

			expect(caught.cause).toBeInstanceOf(PollTimeoutError);
			expect(caught.message).toContain("last observed state: unknown");
		});

		it("should throw when task is CANCELLED", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockResponse({ body: taskBody({ state: "QUEUED" }), status: 200 });
			http.mockResponse({ body: taskBody({ state: "CANCELLED" }), status: 200 });

			const runner = makeRunner(http);

			await expect(
				runner.executeScriptAsync({ script: "return 1", timeout: 30_000 }),
			).rejects.toThrow("Execution was cancelled");
		});

		it("should throw when submit returns API error", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockApiError({ message: "Bad request", statusCode: 400 });

			const runner = makeRunner(http);

			await expect(
				runner.executeScriptAsync({ script: "return 1", timeout: 30_000 }),
			).rejects.toThrow(/Bad request/);
		});

		it("should preserve the underlying OpenCloudError as cause on the thrown Error from executeScript", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockApiError({ message: "Bad request", statusCode: 400 });

			const runner = makeRunner(http);

			const caught: unknown = await runner
				.executeScriptAsync({ script: "return 1", timeout: 30_000 })
				.catch((err) => err);

			assert(caught instanceof Error);

			expect(caught.cause).toBeInstanceOf(OpenCloudError);
		});

		it("should coerce non-string output values via JSON serialization", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockResponse({ body: taskBody({ state: "QUEUED" }), status: 200 });
			http.mockResponse({
				body: taskBody({
					output: { results: [42, { nested: true }, "raw"] },
					state: "COMPLETE",
				}),
				status: 200,
			});

			const runner = makeRunner(http);
			const result = await runner.executeScriptAsync({ script: "return 1", timeout: 30_000 });

			expect(result.outputs).toStrictEqual(["42", '{"nested":true}', "raw"]);
		});

		it("should retry luau task submit on transient ECONNRESET", async () => {
			expect.assertions(2);

			const http = createFakeHttpClient();
			const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
			http.mockNetworkError({ cause: reset });
			http.mockResponse({ body: taskBody({ state: "QUEUED" }), status: 200 });
			http.mockResponse({
				body: taskBody({ output: { results: ["ok"] }, state: "COMPLETE" }),
				status: 200,
			});

			const runner = makeRunner(http);
			const result = await runner.executeScriptAsync({ script: "return 1", timeout: 30_000 });

			expect(result.outputs).toStrictEqual(["ok"]);
			expect(http.requests).toHaveLength(3);
		});

		it("should submit against the head URL when placeVersion is omitted", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockResponse({ body: taskBody({ state: "QUEUED" }), status: 200 });
			http.mockResponse({
				body: taskBody({ output: { results: [] }, state: "COMPLETE" }),
				status: 200,
			});

			const runner = makeRunner(http);
			await runner.executeScriptAsync({ script: "return 1", timeout: 30_000 });

			expect(http.requests[0]!.request.url).not.toContain("/versions/");
		});

		it("should submit against the pinned version URL when placeVersion is provided", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockResponse({ body: taskBody({ state: "QUEUED" }), status: 200 });
			http.mockResponse({
				body: taskBody({ output: { results: [] }, state: "COMPLETE" }),
				status: 200,
			});

			const runner = makeRunner(http);
			await runner.executeScriptAsync({
				placeVersion: 99,
				script: "return 1",
				timeout: 30_000,
			});

			expect(http.requests[0]!.request.url).toContain(
				"/places/456/versions/99/luau-execution-session-tasks",
			);
		});

		it("should clamp task timeout to 300 seconds when caller asks for more", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockResponse({ body: taskBody({ state: "QUEUED" }), status: 200 });
			http.mockResponse({
				body: taskBody({ output: { results: [] }, state: "COMPLETE" }),
				status: 200,
			});

			const runner = makeRunner(http);
			await runner.executeScriptAsync({ script: "return 1", timeout: 600_000 });

			const submitBody = http.requests[0]!.request.body!;

			expect(submitBodySchema.assert(submitBody).timeout).toBe("300s");
		});
	});

	describe("binary input", () => {
		it("should name the binary input on a head submit", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockResponse({ body: taskBody({ state: "QUEUED" }), status: 200 });
			http.mockResponse({
				body: taskBody({ output: { results: ["ok"] }, state: "COMPLETE" }),
				status: 200,
			});

			const runner = makeRunner(http);
			await runner.executeScriptAsync({
				binaryInput: INPUT_PATH,
				script: "return 1",
				timeout: 30_000,
			});

			expect(binaryInputSubmitSchema.assert(http.requests[0]!.request.body).binaryInput).toBe(
				INPUT_PATH,
			);
		});

		it("should name the binary input on a pinned submit", async () => {
			expect.assertions(2);

			const http = createFakeHttpClient();
			http.mockResponse({ body: taskBody({ state: "QUEUED" }), status: 200 });
			http.mockResponse({
				body: taskBody({ output: { results: ["ok"] }, state: "COMPLETE" }),
				status: 200,
			});

			const runner = makeRunner(http);
			await runner.executeScriptAsync({
				binaryInput: INPUT_PATH,
				placeVersion: 99,
				script: "return 1",
				timeout: 30_000,
			});

			const { request } = http.requests[0]!;

			expect(request.url).toContain("/versions/99/");
			expect(binaryInputSubmitSchema.assert(request.body).binaryInput).toBe(INPUT_PATH);
		});

		it("should send no binaryInput key when the caller names none", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockResponse({ body: taskBody({ state: "QUEUED" }), status: 200 });
			http.mockResponse({
				body: taskBody({ output: { results: ["ok"] }, state: "COMPLETE" }),
				status: 200,
			});

			const runner = makeRunner(http);
			await runner.executeScriptAsync({ script: "return 1", timeout: 30_000 });

			expect(
				binaryInputSubmitSchema.assert(http.requests[0]!.request.body),
			).not.toHaveProperty("binaryInput");
		});

		it("should allocate a slot for the payload's size and PUT the bytes at it", async () => {
			expect.assertions(5);

			const http = createFakeHttpClient();
			http.mockResponse({
				body: validBinaryInputBody({ path: INPUT_PATH, uploadUri: UPLOAD_URI }),
				status: 200,
			});
			const { calls, fetchFn } = makeFakeFetch(200);
			const payload = new Uint8Array([1, 2, 3, 4, 5]);

			const runner = makeRunner(http, rbxlBuffer(), fetchFn);
			const result = await runner.uploadBinaryInputAsync({ payload });

			expect(http.requests[0]!.request.url).toContain(
				"/universes/123/luau-execution-session-task-binary-inputs",
			);
			expect(createBodySchema.assert(http.requests[0]!.request.body).size).toBe(5);
			expect(calls).toStrictEqual([{ body: payload, method: "PUT", url: UPLOAD_URI }]);
			expect(result.path).toBe(INPUT_PATH);
			expect(result.uploadMs).toBeGreaterThanOrEqual(0);
		});

		it("should name the slot allocation and its status when the create fails", async () => {
			expect.assertions(2);

			const http = createFakeHttpClient();
			http.mockError(new ApiError("quota", { statusCode: 400 }));
			const { calls, fetchFn } = makeFakeFetch(200);

			const runner = makeRunner(http, rbxlBuffer(), fetchFn);

			await expect(
				runner.uploadBinaryInputAsync({ payload: new Uint8Array([1]) }),
			).rejects.toThrow("Failed to allocate a binary input slot (HTTP 400): quota");
			expect(calls).toStrictEqual([]);
		});

		it("should name the slot allocation alone when the create never reached a response", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockError(new NetworkError("socket hang up"));
			const { fetchFn } = makeFakeFetch(200);

			const runner = makeRunner(http, rbxlBuffer(), fetchFn);

			await expect(
				runner.uploadBinaryInputAsync({ payload: new Uint8Array([1]) }),
			).rejects.toThrow("Failed to allocate a binary input slot: socket hang up");
		});

		it("should name the PUT and its status when the upload is refused", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockResponse({
				body: validBinaryInputBody({ path: INPUT_PATH, uploadUri: UPLOAD_URI }),
				status: 200,
			});
			const { fetchFn } = makeFakeFetch(403, "denied");

			const runner = makeRunner(http, rbxlBuffer(), fetchFn);

			await expect(
				runner.uploadBinaryInputAsync({ payload: new Uint8Array([1]) }),
			).rejects.toThrow("Failed to PUT the binary input (HTTP 403): denied");
		});

		it("should carry the create error as the cause", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			const failure = new ApiError("quota", { statusCode: 400 });
			http.mockError(failure);

			const runner = makeRunner(http, rbxlBuffer(), makeFakeFetch(200).fetchFn);
			const thrown: unknown = await runner
				.uploadBinaryInputAsync({ payload: new Uint8Array([1]) })
				.catch((err: unknown) => err);

			assert(thrown instanceof Error);

			expect(thrown.cause).toBe(failure);
		});
	});

	describe("default option fallbacks", () => {
		it("should default readFile to fs.readFileSync when omitted", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			const runner = new OcaleRunner(
				{ apiKey: "k", placeId: "456", universeId: "123" },
				{ httpClient: http, sleep: createFakeSleep() },
			);

			await expect(
				runner.uploadPlaceAsync({ placeFilePath: "/nonexistent.rbxl" }),
			).rejects.toThrow(/ENOENT/);
		});

		it("should accept a custom baseUrl option", () => {
			expect.assertions(1);

			const runner = new OcaleRunner(
				{ apiKey: "k", placeId: "456", universeId: "123" },
				{ baseUrl: "http://127.0.0.1:4010" },
			);

			expect(runner).toBeInstanceOf(OcaleRunner);
		});

		it("should construct a default fetch-backed http client when none provided", () => {
			expect.assertions(1);

			const runner = new OcaleRunner({ apiKey: "k", placeId: "456", universeId: "123" });

			expect(runner).toBeInstanceOf(OcaleRunner);
		});
	});
});
