import { ApiError, PollTimeoutError, RateLimitError } from "@bedrock-rbx/ocale";
import {
	createFakeHttpClient,
	createFakeSleep,
	type FakeHttpClient,
	validBinaryInputBody,
} from "@bedrock-rbx/ocale/testing";
import { fromAny } from "@total-typescript/shoehorn";

import { type } from "arktype";
import buffer from "node:buffer";
import { assert, describe, expect, it, onTestFinished, vi } from "vitest";

import type { ExecutionTimeoutError } from "./execution-timeout.ts";
import { OcaleRunner } from "./ocale-runner.ts";
import type { ExecuteScriptOptions } from "./runner-types.ts";
import type { TaskStallError } from "./task-stall-error.ts";

const RBXL_SIGNATURE = new Uint8Array([
	0x3c, 0x72, 0x6f, 0x62, 0x6c, 0x6f, 0x78, 0x21, 0x89, 0xff, 0x0d, 0x0a, 0x1a, 0x0a,
]);

interface TaskBodyOverrides {
	error?: { code: string; message: string };
	output?: { results: ReadonlyArray<unknown> };
	path?: string;
	state?: "CANCELLED" | "COMPLETE" | "FAILED" | "PROCESSING" | "QUEUED";
	updateTime?: string;
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
		updateTime: overrides.updateTime ?? "2026-01-01T00:00:30Z",
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
const createBodySchema = type({ size: "number" });

const INPUT_PATH = "universes/123/luau-execution-session-task-binary-inputs/input-1";
const UPLOAD_URI = "https://upload.example/slot-1";

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

const POLL_STEP_MS = 500;

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

function withUnansweredReads(http: FakeHttpClient): Pick<FakeHttpClient, "request"> {
	return {
		request: async (request, config) => {
			if (request.method === "GET") {
				await new Promise((resolve) => {
					config.signal?.addEventListener("abort", resolve, { once: true });
				});
			}

			return http.request(request, config);
		},
	};
}

function makeRunner(
	httpClient: FakeHttpClient,
	{ fetchFunc }: { fetchFunc?: typeof globalThis.fetch } = {},
) {
	return new OcaleRunner(
		{ apiKey: "test-key", placeId: "456", universeId: "123" },
		{
			...(fetchFunc === undefined ? {} : { fetch: fetchFunc }),
			httpClient,
			readFile: () => rbxlBuffer(),
			sleep: createFakeSleep(),
		},
	);
}

describe(OcaleRunner, () => {
	describe("uploadPlace", () => {
		it("should save a place to the place its credentials name", async () => {
			expect.assertions(2);

			const http = createFakeHttpClient();
			http.mockResponse({ body: { versionNumber: 7 }, status: 200 });

			const runner = makeRunner(http);
			const result = await runner.uploadPlaceAsync({ placeFilePath: "/work/test.rbxl" });

			expect(result.versionNumber).toBe(7);
			expect(http.requests[0]!.request.url).toContain("/places/456/versions");
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
		it("should report when Open Cloud accepts the task", async () => {
			expect.assertions(2);

			const http = createFakeHttpClient();
			mockCompletion(http, ["ok"]);
			const onSubmitted = vi.fn<() => void>();
			const observation = new AbortController();

			const result = await makeRunner(http).executeScriptAsync({
				observationSignal: observation.signal,
				onSubmitted: () => {
					onSubmitted();
				},
				script: "return 1",
				timeout: 30_000,
			});

			expect(onSubmitted).toHaveBeenCalledExactlyOnceWith();
			expect(result.outputs).toStrictEqual(["ok"]);
		});

		it("should wait for place capacity through the injected capacity wait", async () => {
			expect.assertions(2);

			const http = createFakeHttpClient();
			http.mockError(
				new RateLimitError("Rate limited", {
					details: {
						code: "RESOURCE_EXHAUSTED",
						message:
							"Too many tasks already active: universes/123/places/456/versions/1/luau-execution-sessions/11111111-1111-4111-8111-111111111111/tasks/22222222-2222-4222-8222-222222222222",
					},
					remaining: 3,
					retryAfterSeconds: 5,
					statusCode: 429,
				}),
			);
			http.mockResponse({ body: { state: "PROCESSING" }, status: 200 });
			const capacityWaitAsync = vi.fn<
				(ms: number, signal: AbortSignal | undefined) => Promise<void>
			>(async () => {
				throw new Error("capacity wait reached");
			});
			const runner = new OcaleRunner(
				{ apiKey: "test-key", placeId: "456", universeId: "123" },
				{ capacityWaitAsync, httpClient: http, sleep: createFakeSleep() },
			);

			await expect(
				runner.executeScriptAsync({
					script: "return 1",
					submitBudget: 90_000,
					submitCapacityBudget: 405_000,
					timeout: 30_000,
				}),
			).rejects.toThrow("capacity wait reached");
			expect(capacityWaitAsync).toHaveBeenCalledWith(5000, expect.any(AbortSignal));
		});

		it("should capture caller options before submission and its callback mutate them", async () => {
			expect.assertions(3);

			useClock();
			const http = createFakeHttpClient();
			mockCompletion(http, ["original operation"]);
			const originalCallback = vi.fn<() => void>();
			const originalObservation = new AbortController();
			const options: ExecuteScriptOptions = {
				observationSignal: originalObservation.signal,
				onSubmitted: () => {
					originalCallback();
					vi.setSystemTime(Date.now() + 5000);
					delete options.submitBudget;
					options.observationSignal = AbortSignal.abort("reused options");
				},
				pollBudget: 2000,
				script: "return 1",
				submitBudget: 1000,
				timeout: 1000,
			};
			const result = makeRunner(http).executeScriptAsync(options);
			options.onSubmitted = () => {
				throw new Error("replaced callback");
			};

			await expect(result).resolves.toMatchObject({ outputs: ["original operation"] });
			expect(originalCallback).toHaveBeenCalledExactlyOnceWith();
			expect(http.requests).toHaveLength(2);
		});

		it("should stop observing a submitted task when its signal is aborted", async () => {
			expect.assertions(2);

			const http = createFakeHttpClient();
			http.mockResponse({ body: taskBody(), status: 200 });
			const observation = new AbortController();
			observation.abort("result no longer needed");

			await expect(
				makeRunner(http).executeScriptAsync({
					observationSignal: observation.signal,
					script: "return 1",
					timeout: 30_000,
				}),
			).rejects.toMatchObject({ cause: { reason: "result no longer needed" } });
			expect(http.requests).toStrictEqual([]);
		});

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

		it("should return empty outputs when COMPLETE task has no results", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			mockCompletion(http, []);

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

			const observation = new AbortController();
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
				.executeScriptAsync({
					observationSignal: observation.signal,
					script: "return 1",
					timeout: 30_000,
				})
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

		it("should fail a task that stays PROCESSING at the deadline its submit started", async () => {
			expect.assertions(3);

			const http = createFakeHttpClient();
			http.mockError(
				new RateLimitError("Rate limited", {
					details: { errors: [{ code: 0, message: "" }] },
					retryAfterSeconds: 20,
					statusCode: 429,
				}),
			);
			http.mockResponse({ body: taskBody({ state: "PROCESSING" }), status: 200 });
			mockProcessing(http, 200);
			const runner = makeAdvancingRunner(http);
			const startedAt = Date.now();

			const caught: unknown = await runner
				.executeScriptAsync({ script: "return 1", timeout: 30_000 })
				.catch((err: unknown) => err);

			assert(caught instanceof Error);

			expect(caught.message).toContain("within 75s");
			expect(Date.now() - startedAt).toBeGreaterThanOrEqual(75_000);
			expect(Date.now() - startedAt).toBeLessThan(80_000);
		});

		it("should report a poll read the deadline cut off as a timeout", async () => {
			expect.assertions(2);

			const http = createFakeHttpClient();
			http.mockResponse({ body: taskBody({ state: "PROCESSING" }), status: 200 });
			const runner = new OcaleRunner(
				{ apiKey: "test-key", placeId: "456", universeId: "123" },
				{ httpClient: withUnansweredReads(http) },
			);

			const caught: unknown = await runner
				.executeScriptAsync({ pollBudget: 50, script: "return 1", timeout: 1000 })
				.catch((err: unknown) => err);

			assert(caught instanceof Error);

			expect(caught.cause).toBeInstanceOf(PollTimeoutError);
			expect(caught.message).toContain("within 0s");
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

		it("should read the original terminal task after timeout", async () => {
			expect.assertions(3);

			const { caught, http } = await timeoutExecutionAsync();
			http.mockResponse({
				body: taskBody({
					output: { results: ["original result", 42] },
					state: "COMPLETE",
				}),
				status: 200,
			});

			await expect(
				fromAny<ExecutionTimeoutError, typeof caught>(caught).readResultAsync(),
			).resolves.toStrictEqual({
				durationMs: 500,
				outputs: ["original result", "42"],
				terminalTask: {
					ref: { sessionId: "session-1", taskId: "task-1" },
					state: "COMPLETE",
				},
			});
			expect(http.requests.map(({ request }) => request.method)).toStrictEqual([
				"POST",
				"GET",
				"GET",
			]);
			expect(http.requests[2]!.request.url).toBe(
				"/cloud/v2/universes/123/places/456/versions/1/luau-execution-sessions/session-1/tasks/task-1?view=BASIC",
			);
		});

		it("should cancel a recovery read before making another request", async () => {
			expect.assertions(2);

			const { caught, http } = await timeoutExecutionAsync();
			const recovery = new AbortController();
			recovery.abort("another attempt returned the result");

			await expect(
				fromAny<ExecutionTimeoutError, typeof caught>(caught).readResultAsync(
					recovery.signal,
				),
			).rejects.toThrow("Polling was aborted");
			expect(http.requests).toHaveLength(2);
		});

		it("should recover with a fresh signal after the initial observation is canceled", async () => {
			expect.assertions(2);

			const http = createFakeHttpClient();
			http.mockResponse({ body: taskBody(), status: 200 });
			mockProcessing(http, 1);
			const original = new AbortController();
			const caught: unknown = await makeAdvancingRunner(http)
				.executeScriptAsync({
					observationSignal: original.signal,
					pollBudget: 1,
					script: "return 1",
					timeout: 1000,
				})
				.catch((err: unknown) => err);
			assert(caught instanceof Error);
			original.abort();
			const recovery = new AbortController();
			http.mockResponse({
				body: taskBody({ output: { results: ["late result"] }, state: "COMPLETE" }),
				status: 200,
			});

			await expect(
				fromAny<ExecutionTimeoutError, typeof caught>(caught).readResultAsync(
					recovery.signal,
				),
			).resolves.toMatchObject({
				outputs: ["late result"],
			});

			recovery.abort();

			expect(http.requests[2]!.config.signal).toStrictEqual(
				expect.objectContaining({ aborted: true }),
			);
		});

		it("should carry recovery cancellation through terminal failure logs", async () => {
			expect.assertions(2);

			const { caught, http } = await timeoutExecutionAsync();
			const recovery = new AbortController();
			mockOriginalFailure(http);

			await expect(
				fromAny<ExecutionTimeoutError, typeof caught>(caught).readResultAsync(
					recovery.signal,
				),
			).rejects.toThrow("original traceback");

			recovery.abort();

			expect(http.requests[3]!.config.signal).toStrictEqual(
				expect.objectContaining({ aborted: true }),
			);
		});

		it("should recover an original that completes within the recovery budget", async () => {
			expect.assertions(1);

			const { caught, http } = await timeoutExecutionAsync();
			http.mockResponse({ body: taskBody({ state: "PROCESSING" }), status: 200 });
			http.mockResponse({
				body: taskBody({ output: { results: ["late result"] }, state: "COMPLETE" }),
				status: 200,
			});

			await expect(
				fromAny<ExecutionTimeoutError, typeof caught>(caught).readResultAsync(),
			).resolves.toMatchObject({
				outputs: ["late result"],
			});
		});

		it("should fail when the original never becomes terminal within the recovery budget", async () => {
			expect.assertions(1);

			const { caught, http } = await timeoutExecutionAsync();
			mockProcessing(http, POLLS_PER_GRACE);

			await expect(
				fromAny<ExecutionTimeoutError, typeof caught>(caught).readResultAsync(),
			).rejects.toThrow("Roblox never reported a terminal state for the task within 46s");
		});

		it("should poll past a stale processing replica after observing completion", async () => {
			expect.assertions(3);

			const { caught, http } = await timeoutExecutionAsync();
			http.mockResponse({
				body: taskBody({
					output: { results: ["original result"] },
					state: "COMPLETE",
				}),
				status: 200,
			});

			await expect(
				fromAny<ExecutionTimeoutError, typeof caught>(caught).readResultAsync(),
			).resolves.toMatchObject({
				outputs: ["original result"],
			});

			http.mockResponse({
				body: taskBody({ state: "PROCESSING", updateTime: "2026-01-01T00:00:00Z" }),
				status: 200,
			});
			http.mockResponse({
				body: taskBody({
					output: { results: ["original result"] },
					state: "COMPLETE",
				}),
				status: 200,
			});

			await expect(
				fromAny<ExecutionTimeoutError, typeof caught>(caught).readResultAsync(),
			).resolves.toMatchObject({
				outputs: ["original result"],
			});
			expect(http.requests.map(({ request }) => request.method)).toStrictEqual([
				"POST",
				"GET",
				"GET",
				"GET",
				"GET",
			]);
		});

		it("should report the original terminal failure when re-reading after timeout", async () => {
			expect.assertions(2);

			const { caught, http } = await timeoutExecutionAsync();
			mockOriginalFailure(http);

			await expect(
				fromAny<ExecutionTimeoutError, typeof caught>(caught).readResultAsync(),
			).rejects.toThrow("original traceback");
			expect(http.requests.map(({ request }) => request.method)).toStrictEqual([
				"POST",
				"GET",
				"GET",
				"GET",
			]);
		});

		it("should report an original-task read failure without creating another task", async () => {
			expect.assertions(2);

			const { caught, http } = await timeoutExecutionAsync();
			http.mockApiError({ message: "Forbidden", statusCode: 403 });

			await expect(
				fromAny<ExecutionTimeoutError, typeof caught>(caught).readResultAsync(),
			).rejects.toThrow("Forbidden");
			expect(http.requests.map(({ request }) => request.method)).toStrictEqual([
				"POST",
				"GET",
				"GET",
			]);
		});

		it("should say the state is unknown when the budget outran the first poll", async () => {
			expect.assertions(2);

			// A submit answered after the whole task deadline leaves the poll
			// no time for a single read, so there is no state to report.
			let clock = 1_000_000;
			vi.spyOn(Date, "now").mockImplementation(() => clock);

			const http = createFakeHttpClient();
			http.mockResponse({ body: taskBody({ state: "QUEUED" }), status: 200 });

			const runner = new OcaleRunner(
				{ apiKey: "test-key", placeId: "456", universeId: "123" },
				{
					httpClient: {
						request: async (request, config) => {
							const response = await http.request(request, config);
							clock += 100_000;
							return response;
						},
					},
					readFile: () => rbxlBuffer(),
					sleep: createFakeSleep(),
				},
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

		it("should clamp task timeout to 300 seconds when caller asks for more", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			mockCompletion(http, []);

			const runner = makeRunner(http);
			await runner.executeScriptAsync({ script: "return 1", timeout: 600_000 });

			const submitBody = http.requests[0]!.request.body!;

			expect(submitBodySchema.assert(submitBody).timeout).toBe("300s");
		});
	});

	describe("binary input", () => {
		it("should allocate a slot for the payload's size and PUT the bytes at it", async () => {
			expect.assertions(5);

			const http = createFakeHttpClient();
			http.mockResponse({
				body: validBinaryInputBody({ path: INPUT_PATH, uploadUri: UPLOAD_URI }),
				status: 200,
			});
			const { calls, fetchFn } = makeFakeFetch(200);
			const payload = new Uint8Array([1, 2, 3, 4, 5]);

			const runner = makeRunner(http, { fetchFunc: fetchFn });
			const result = await runner.uploadBinaryInputAsync({ payload });

			expect(http.requests[0]!.request.url).toContain(
				"/universes/123/luau-execution-session-task-binary-inputs",
			);
			expect(createBodySchema.assert(http.requests[0]!.request.body).size).toBe(5);
			expect(calls).toStrictEqual([{ body: payload, method: "PUT", url: UPLOAD_URI }]);
			expect(result.path).toBe(INPUT_PATH);
			expect(result.uploadMs).toBeGreaterThanOrEqual(0);
		});
	});

	describe("infrastructure failures", () => {
		it("should classify a task still unfinished at its deadline as a stall, with its evidence", async () => {
			expect.assertions(1);

			const stalled = taskBody({ state: "PROCESSING", updateTime: "2026-01-01T00:00:00Z" });
			const http = createFakeHttpClient();
			for (let index = 0; index < POLLS_PER_GRACE; index += 1) {
				http.mockResponse({ body: stalled, status: 200 });
			}

			const caught: unknown = await makeAdvancingRunner(http)
				.executeScriptAsync({ placeVersion: 1, script: "return 1", timeout: 1000 })
				.catch((err: unknown) => err);
			assert(caught instanceof Error);

			expect(fromAny<TaskStallError, typeof caught>(caught).evidence).toStrictEqual({
				createTime: "2026-01-01T00:00:00.000Z",
				kind: "task-stall",
				observedStates: ["PROCESSING"],
				placeVersion: 1,
				task: "universes/123/places/456/versions/1/luau-execution-sessions/session-1/tasks/task-1",
				timeoutSeconds: 1,
				updateTime: "2026-01-01T00:00:00.000Z",
			});
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

interface FetchCall {
	body: Uint8Array;
	method: string;
	url: string;
}

function useClock(): void {
	vi.useFakeTimers();
	onTestFinished(() => {
		vi.useRealTimers();
	});
}

const POLLS_PER_DEADLINE = 10_000 / POLL_STEP_MS;

function mockCompletion(http: FakeHttpClient, results: ReadonlyArray<unknown>): void {
	http.mockResponse({ body: taskBody({ state: "QUEUED" }), status: 200 });
	http.mockResponse({ body: taskBody({ output: { results }, state: "COMPLETE" }), status: 200 });
}

function mockOriginalFailure(http: FakeHttpClient): void {
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
}

async function timeoutExecutionAsync(): Promise<{
	caught: ExecutionTimeoutError;
	http: FakeHttpClient;
}> {
	const http = createFakeHttpClient();
	http.mockResponse({ body: taskBody(), status: 200 });
	mockProcessing(http, 1);
	const caught: unknown = await makeAdvancingRunner(http)
		.executeScriptAsync({ pollBudget: 1, script: "return 1", timeout: 1000 })
		.catch((err: unknown) => err);
	assert(caught instanceof Error);
	return { caught: fromAny<ExecutionTimeoutError, typeof caught>(caught), http };
}
