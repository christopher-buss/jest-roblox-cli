/* cspell:words ocale */
import buffer from "node:buffer";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import { createOcaleRunnerFromEnvironment } from "./auto.ts";
import type { HttpClient, HttpResponse } from "./http-client.ts";
import { OcaleRunner } from "./ocale-runner.ts";

const LUAU_EXEC_TASKS_PATH = "/luau-execution-session-tasks";

function createMockHttpClient(
	responses: Map<string, Array<HttpResponse> | HttpResponse>,
): HttpClient & { calls: Array<{ body?: unknown; method: string; url: string }> } {
	const calls: Array<{ body?: unknown; method: string; url: string }> = [];
	const indexes = new Map<string, number>();

	return {
		calls,
		async request(method, url, options) {
			calls.push({ body: options?.body, method, url });

			for (const [pattern, response] of responses) {
				if (url.includes(pattern)) {
					if (!Array.isArray(response)) {
						return response;
					}

					const index = indexes.get(pattern) ?? 0;
					indexes.set(pattern, index + 1);

					return response[Math.min(index, response.length - 1)]!;
				}
			}

			return { body: { error: "Not found" }, ok: false, status: 404 };
		},
	};
}

async function noSleep() {}

const UPLOAD_OK: HttpResponse = { body: { versionNumber: 1 }, ok: true, status: 200 };
const TASK_CREATED: HttpResponse = { body: { path: "task-path" }, ok: true, status: 200 };
const TASK_CREATED_WITH_ID: HttpResponse = {
	body: { path: "universes/123/places/456/luau-execution-session-tasks/task-id" },
	ok: true,
	status: 200,
};
const PROCESSING: HttpResponse = { body: { state: "PROCESSING" }, ok: true, status: 200 };

function completeResponse(results: Array<string>): HttpResponse {
	return {
		body: { output: { results }, state: "COMPLETE" },
		ok: true,
		status: 200,
	};
}

describe(OcaleRunner, () => {
	const credentials = {
		apiKey: "test-api-key",
		placeId: "456",
		universeId: "123",
	};

	describe("uploadPlace", () => {
		it("should upload place file successfully", async () => {
			expect.assertions(3);

			const mockHttp = createMockHttpClient(new Map([["/versions", UPLOAD_OK]]));

			const runner = new OcaleRunner(credentials, {
				http: mockHttp,
				readFile: () => buffer.Buffer.from("mock-rbxl"),
				sleep: noSleep,
			});

			const result = await runner.uploadPlace({ placeFilePath: "./test.rbxl" });

			expect(result.cached).toBe(false);
			expect(result.versionNumber).toBe(1);
			expect(mockHttp.calls[0]!.url).toContain("/versions");
		});

		it("should skip upload when cache hit", async () => {
			expect.assertions(3);

			const mockHttp = createMockHttpClient(new Map([["/versions", UPLOAD_OK]]));

			const uniqueContent = `cache-test-${Date.now()}`;
			const runner = new OcaleRunner(credentials, {
				http: mockHttp,
				readFile: () => buffer.Buffer.from(uniqueContent),
				sleep: noSleep,
			});

			const result1 = await runner.uploadPlace({ cache: true, placeFilePath: "./test.rbxl" });

			expect(result1.cached).toBe(false);

			const result2 = await runner.uploadPlace({ cache: true, placeFilePath: "./test.rbxl" });

			expect(result2.cached).toBe(true);
			expect(mockHttp.calls.filter((call) => call.url.includes("/versions"))).toHaveLength(1);
		});

		it("should not use cache when cache option is false", async () => {
			expect.assertions(2);

			const mockHttp = createMockHttpClient(new Map([["/versions", UPLOAD_OK]]));

			const runner = new OcaleRunner(credentials, {
				http: mockHttp,
				readFile: () => buffer.Buffer.from("mock-rbxl"),
				sleep: noSleep,
			});

			const result = await runner.uploadPlace({ cache: false, placeFilePath: "./test.rbxl" });

			expect(result.cached).toBe(false);
			expect(mockHttp.calls.filter((call) => call.url.includes("/versions"))).toHaveLength(1);
		});

		it("should throw on upload failure", async () => {
			expect.assertions(1);

			const mockHttp = createMockHttpClient(
				new Map([
					["/versions", { body: { error: "Unauthorized" }, ok: false, status: 401 }],
				]),
			);

			const runner = new OcaleRunner(credentials, {
				http: mockHttp,
				readFile: () => buffer.Buffer.from("mock"),
				sleep: noSleep,
			});

			await expect(runner.uploadPlace({ placeFilePath: "./test.rbxl" })).rejects.toThrow(
				/Failed to upload place/,
			);
		});

		it("should throw when response has no versionNumber", async () => {
			expect.assertions(1);

			const mockHttp = createMockHttpClient(
				new Map([["/versions", { body: {}, ok: true, status: 200 }]]),
			);

			const runner = new OcaleRunner(credentials, {
				http: mockHttp,
				readFile: () => buffer.Buffer.from("mock"),
				sleep: noSleep,
			});

			await expect(runner.uploadPlace({ placeFilePath: "./test.rbxl" })).rejects.toThrow(
				"missing versionNumber",
			);
		});

		it("should throw when response body is not an object", async () => {
			expect.assertions(1);

			const mockHttp = createMockHttpClient(
				new Map([["/versions", { body: "ok", ok: true, status: 200 }]]),
			);

			const runner = new OcaleRunner(credentials, {
				http: mockHttp,
				readFile: () => buffer.Buffer.from("mock"),
				sleep: noSleep,
			});

			await expect(runner.uploadPlace({ placeFilePath: "./test.rbxl" })).rejects.toThrow(
				"missing versionNumber",
			);
		});

		it("should throw when versionNumber is not numeric", async () => {
			expect.assertions(1);

			const mockHttp = createMockHttpClient(
				new Map([["/versions", { body: { versionNumber: "abc" }, ok: true, status: 200 }]]),
			);

			const runner = new OcaleRunner(credentials, {
				http: mockHttp,
				readFile: () => buffer.Buffer.from("mock"),
				sleep: noSleep,
			});

			await expect(runner.uploadPlace({ placeFilePath: "./test.rbxl" })).rejects.toThrow(
				"missing versionNumber",
			);
		});

		it("should default cache to false when option not provided", async () => {
			expect.assertions(2);

			const mockHttp = createMockHttpClient(new Map([["/versions", UPLOAD_OK]]));

			const runner = new OcaleRunner(credentials, {
				http: mockHttp,
				readFile: () => buffer.Buffer.from("same-content"),
				sleep: noSleep,
			});

			await runner.uploadPlace({ placeFilePath: "./test.rbxl" });
			await runner.uploadPlace({ placeFilePath: "./test.rbxl" });

			expect(mockHttp.calls.filter((call) => call.url.includes("/versions"))).toHaveLength(2);
			expect(mockHttp.calls).toHaveLength(2);
		});
	});

	describe("executeScript", () => {
		it("should throw when timeout is zero or negative", async () => {
			expect.assertions(2);

			const runner = new OcaleRunner(credentials, {
				http: createMockHttpClient(new Map()),
				sleep: noSleep,
			});

			await expect(runner.executeScript({ script: "return 1", timeout: 0 })).rejects.toThrow(
				"Timeout must be a positive number",
			);
			await expect(
				runner.executeScript({ script: "return 1", timeout: -1000 }),
			).rejects.toThrow("Timeout must be a positive number");
		});

		it("should create task and return outputs on success", async () => {
			expect.assertions(2);

			const mockHttp = createMockHttpClient(
				new Map([
					["task-id", completeResponse(["result-1", "result-2"])],
					[LUAU_EXEC_TASKS_PATH, TASK_CREATED_WITH_ID],
				]),
			);

			const runner = new OcaleRunner(credentials, {
				http: mockHttp,
				sleep: noSleep,
			});

			const result = await runner.executeScript({
				script: "return 'hello'",
				timeout: 30_000,
			});

			expect(result.outputs).toStrictEqual(["result-1", "result-2"]);
			expect(result.durationMs).toBeGreaterThanOrEqual(0);
		});

		it("should poll until task is complete", async () => {
			expect.assertions(1);

			const mockHttp = createMockHttpClient(
				new Map<string, Array<HttpResponse> | HttpResponse>([
					["task-path", [PROCESSING, PROCESSING, completeResponse(["done"])]],
					[LUAU_EXEC_TASKS_PATH, TASK_CREATED],
				]),
			);

			const runner = new OcaleRunner(credentials, {
				http: mockHttp,
				sleep: noSleep,
			});

			await runner.executeScript({ script: "return 1", timeout: 30_000 });

			const pollCalls = mockHttp.calls.filter((call) => call.url.includes("task-path"));

			expect(pollCalls).toHaveLength(3);
		});

		it("should throw on task creation failure", async () => {
			expect.assertions(1);

			const mockHttp = createMockHttpClient(
				new Map([
					[
						LUAU_EXEC_TASKS_PATH,
						{ body: { error: "Bad request" }, ok: false, status: 400 },
					],
				]),
			);

			const runner = new OcaleRunner(credentials, {
				http: mockHttp,
				sleep: noSleep,
			});

			await expect(
				runner.executeScript({ script: "return 1", timeout: 30_000 }),
			).rejects.toThrow("Failed to create execution task: 400");
		});

		it("should throw on execution failure", async () => {
			expect.assertions(1);

			const mockHttp = createMockHttpClient(
				new Map([
					[
						"task-path",
						{
							body: { error: { message: "Script error" }, state: "FAILED" },
							ok: true,
							status: 200,
						},
					],
					[LUAU_EXEC_TASKS_PATH, TASK_CREATED],
				]),
			);

			const runner = new OcaleRunner(credentials, {
				http: mockHttp,
				sleep: noSleep,
			});

			await expect(
				runner.executeScript({ script: "return 1", timeout: 30_000 }),
			).rejects.toThrow("Script error");
		});

		it("should use fallback message when error has no message field", async () => {
			expect.assertions(1);

			const mockHttp = createMockHttpClient(
				new Map([
					["task-path", { body: { error: {}, state: "FAILED" }, ok: true, status: 200 }],
					[LUAU_EXEC_TASKS_PATH, TASK_CREATED],
				]),
			);

			const runner = new OcaleRunner(credentials, {
				http: mockHttp,
				sleep: noSleep,
			});

			await expect(
				runner.executeScript({ script: "return 1", timeout: 30_000 }),
			).rejects.toThrow("Execution failed");
		});

		it("should throw on CANCELLED task state", async () => {
			expect.assertions(1);

			const mockHttp = createMockHttpClient(
				new Map([
					["task-path", { body: { state: "CANCELLED" }, ok: true, status: 200 }],
					[LUAU_EXEC_TASKS_PATH, TASK_CREATED],
				]),
			);

			const runner = new OcaleRunner(credentials, {
				http: mockHttp,
				sleep: noSleep,
			});

			await expect(
				runner.executeScript({ script: "return 1", timeout: 30_000 }),
			).rejects.toThrow("Execution was cancelled");
		});

		it("should throw when execution times out", async () => {
			expect.assertions(1);

			const mockHttp = createMockHttpClient(
				new Map([
					["task-path", PROCESSING],
					[LUAU_EXEC_TASKS_PATH, TASK_CREATED],
				]),
			);

			const runner = new OcaleRunner(credentials, {
				http: mockHttp,
				sleep: noSleep,
			});

			await expect(runner.executeScript({ script: "return 1", timeout: 1 })).rejects.toThrow(
				"Execution timed out",
			);
		});

		it("should throw when poll response is not ok", async () => {
			expect.assertions(1);

			const mockHttp = createMockHttpClient(
				new Map([
					["task-path", { body: { error: "Internal error" }, ok: false, status: 500 }],
					[LUAU_EXEC_TASKS_PATH, TASK_CREATED],
				]),
			);

			const runner = new OcaleRunner(credentials, {
				http: mockHttp,
				sleep: noSleep,
			});

			await expect(
				runner.executeScript({ script: "return 1", timeout: 30_000 }),
			).rejects.toThrow("Failed to poll task: 500");
		});

		it("should retry on 429 rate limit then succeed", async () => {
			expect.assertions(2);

			const mockHttp = createMockHttpClient(
				new Map<string, Array<HttpResponse> | HttpResponse>([
					[
						"task-path",
						[
							{ body: {}, headers: { "retry-after": "1" }, ok: false, status: 429 },
							completeResponse(["ok"]),
						],
					],
					[LUAU_EXEC_TASKS_PATH, TASK_CREATED],
				]),
			);

			const sleepCalls: Array<number> = [];
			const runner = new OcaleRunner(credentials, {
				http: mockHttp,
				sleep: async (ms) => {
					sleepCalls.push(ms);
				},
			});

			const result = await runner.executeScript({ script: "return 1", timeout: 30_000 });

			expect(result.outputs).toStrictEqual(["ok"]);
			expect(sleepCalls[0]).toBe(1000);
		});

		it("should throw after exceeding max rate limit retries", async () => {
			expect.assertions(1);

			const mockHttp = createMockHttpClient(
				new Map([
					["task-path", { body: {}, headers: {}, ok: false, status: 429 }],
					[LUAU_EXEC_TASKS_PATH, TASK_CREATED],
				]),
			);

			const runner = new OcaleRunner(credentials, {
				http: mockHttp,
				sleep: noSleep,
			});

			await expect(
				runner.executeScript({ script: "return 1", timeout: 30_000 }),
			).rejects.toThrow("Rate limited by Open Cloud API after multiple retries");
		});

		it("should use default retry wait when retry-after is invalid", async () => {
			expect.assertions(1);

			const mockHttp = createMockHttpClient(
				new Map<string, Array<HttpResponse> | HttpResponse>([
					[
						"task-path",
						[
							{
								body: {},
								headers: { "retry-after": "not-a-number" },
								ok: false,
								status: 429,
							},
							completeResponse(["ok"]),
						],
					],
					[LUAU_EXEC_TASKS_PATH, TASK_CREATED],
				]),
			);

			const sleepCalls: Array<number> = [];
			const runner = new OcaleRunner(credentials, {
				http: mockHttp,
				sleep: async (ms) => {
					sleepCalls.push(ms);
				},
			});

			await runner.executeScript({ script: "return 1", timeout: 30_000 });

			expect(sleepCalls[0]).toBe(5000);
		});

		it("should use default retry wait when retry-after header missing", async () => {
			expect.assertions(1);

			const mockHttp = createMockHttpClient(
				new Map<string, Array<HttpResponse> | HttpResponse>([
					["task-path", [{ body: {}, ok: false, status: 429 }, completeResponse(["ok"])]],
					[LUAU_EXEC_TASKS_PATH, TASK_CREATED],
				]),
			);

			const sleepCalls: Array<number> = [];
			const runner = new OcaleRunner(credentials, {
				http: mockHttp,
				sleep: async (ms) => {
					sleepCalls.push(ms);
				},
			});

			await runner.executeScript({ script: "return 1", timeout: 30_000 });

			expect(sleepCalls[0]).toBe(5000);
		});

		it("should use default poll interval when not specified", async () => {
			expect.assertions(1);

			const mockHttp = createMockHttpClient(
				new Map<string, Array<HttpResponse> | HttpResponse>([
					["task-path", [PROCESSING, completeResponse(["ok"])]],
					[LUAU_EXEC_TASKS_PATH, TASK_CREATED],
				]),
			);

			const sleepCalls: Array<number> = [];
			const runner = new OcaleRunner(credentials, {
				http: mockHttp,
				sleep: async (ms) => {
					sleepCalls.push(ms);
				},
			});

			await runner.executeScript({ script: "return 1", timeout: 30_000 });

			expect(sleepCalls[0]).toBe(2000);
		});

		it("should return empty outputs when COMPLETE but no results", async () => {
			expect.assertions(1);

			const mockHttp = createMockHttpClient(
				new Map([
					[
						"task-path",
						{ body: { output: {}, state: "COMPLETE" }, ok: true, status: 200 },
					],
					[LUAU_EXEC_TASKS_PATH, TASK_CREATED],
				]),
			);

			const runner = new OcaleRunner(credentials, {
				http: mockHttp,
				sleep: noSleep,
			});

			const result = await runner.executeScript({ script: "return 1", timeout: 30_000 });

			expect(result.outputs).toStrictEqual([]);
		});

		it("should use default sleep when no sleep option provided", async () => {
			expect.assertions(1);

			vi.useFakeTimers();

			const mockHttp = createMockHttpClient(
				new Map<string, Array<HttpResponse> | HttpResponse>([
					["task-path", [PROCESSING, completeResponse(["ok"])]],
					[LUAU_EXEC_TASKS_PATH, TASK_CREATED],
				]),
			);

			const runner = new OcaleRunner(credentials, {
				http: mockHttp,
			});

			const promise = runner.executeScript({ script: "return 1", timeout: 30_000 });
			await vi.advanceTimersByTimeAsync(10_000);

			const result = await promise;

			expect(result.outputs).toStrictEqual(["ok"]);

			vi.useRealTimers();
		});

		it("should use default readFile when no readFile option provided", async () => {
			expect.assertions(1);

			const mockHttp = createMockHttpClient(new Map([["/versions", UPLOAD_OK]]));

			const runner = new OcaleRunner(credentials, {
				http: mockHttp,
				sleep: noSleep,
			});

			await expect(
				runner.uploadPlace({ placeFilePath: "./nonexistent-place-file.rbxl" }),
			).rejects.toThrow(/ENOENT/);
		});

		it("should use default http client when no http option provided", async () => {
			expect.assertions(1);

			const pollBody = {
				output: { results: ["default-client-works"] },
				state: "COMPLETE",
			};

			const fetchMock = vi
				.fn<typeof fetch>()
				// First call: POST to create task
				.mockResolvedValueOnce({
					headers: new Headers({ "content-type": "application/json" }),
					json: async () => ({ path: "task-path" }),
					ok: true,
					status: 200,
				} as unknown as Response)
				// Second call: GET to poll task
				.mockResolvedValueOnce({
					headers: new Headers({ "content-type": "application/json" }),
					json: async () => pollBody,
					ok: true,
					status: 200,
				} as unknown as Response);

			vi.stubGlobal("fetch", fetchMock);

			const runner = new OcaleRunner(credentials);

			const result = await runner.executeScript({
				script: "return 1",
				timeout: 30_000,
			});

			expect(result.outputs).toStrictEqual(["default-client-works"]);
		});
	});
});

function withEnvironmentBackup(callback: () => void): void {
	const backup: Record<string, string | undefined> = {
		ROBLOX_OPEN_CLOUD_API_KEY: process.env["ROBLOX_OPEN_CLOUD_API_KEY"],
		ROBLOX_PLACE_ID: process.env["ROBLOX_PLACE_ID"],
		ROBLOX_UNIVERSE_ID: process.env["ROBLOX_UNIVERSE_ID"],
	};

	try {
		callback();
	} finally {
		for (const [key, value] of Object.entries(backup)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

describe(createOcaleRunnerFromEnvironment, () => {
	it("should throw when ROBLOX_OPEN_CLOUD_API_KEY is missing", () => {
		expect.assertions(1);

		withEnvironmentBackup(() => {
			delete process.env["ROBLOX_OPEN_CLOUD_API_KEY"];
			delete process.env["ROBLOX_UNIVERSE_ID"];
			delete process.env["ROBLOX_PLACE_ID"];

			expect(() => createOcaleRunnerFromEnvironment()).toThrow(
				"ROBLOX_OPEN_CLOUD_API_KEY environment variable is required",
			);
		});
	});

	it("should throw when ROBLOX_UNIVERSE_ID is missing", () => {
		expect.assertions(1);

		withEnvironmentBackup(() => {
			process.env["ROBLOX_OPEN_CLOUD_API_KEY"] = "key";
			delete process.env["ROBLOX_UNIVERSE_ID"];
			delete process.env["ROBLOX_PLACE_ID"];

			expect(() => createOcaleRunnerFromEnvironment()).toThrow(
				"ROBLOX_UNIVERSE_ID environment variable is required",
			);
		});
	});

	it("should throw when ROBLOX_PLACE_ID is missing", () => {
		expect.assertions(1);

		withEnvironmentBackup(() => {
			process.env["ROBLOX_OPEN_CLOUD_API_KEY"] = "key";
			process.env["ROBLOX_UNIVERSE_ID"] = "123";
			delete process.env["ROBLOX_PLACE_ID"];

			expect(() => createOcaleRunnerFromEnvironment()).toThrow(
				"ROBLOX_PLACE_ID environment variable is required",
			);
		});
	});

	it("should create runner when all env vars are set", () => {
		expect.assertions(1);

		withEnvironmentBackup(() => {
			process.env["ROBLOX_OPEN_CLOUD_API_KEY"] = "key";
			process.env["ROBLOX_UNIVERSE_ID"] = "123";
			process.env["ROBLOX_PLACE_ID"] = "456";

			const runner = createOcaleRunnerFromEnvironment();

			expect(runner).toBeInstanceOf(OcaleRunner);
		});
	});
});
