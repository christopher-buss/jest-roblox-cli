import buffer from "node:buffer";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../config/schema.ts";
import type { HttpClient, HttpResponse } from "./http-client.ts";
import type { BackendOptions } from "./interface.ts";
import { createOpenCloudBackend, OpenCloudBackend } from "./open-cloud.ts";

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

function successResult(): string {
	return JSON.stringify({
		numFailedTests: 0,
		numPassedTests: 1,
		numPendingTests: 0,
		numTotalTests: 1,
		startTime: 0,
		success: true,
		testResults: [],
	});
}

function emptySuccessResult(): string {
	return JSON.stringify({
		numFailedTests: 0,
		numPassedTests: 0,
		numPendingTests: 0,
		numTotalTests: 0,
		startTime: 0,
		success: true,
		testResults: [],
	});
}

function completeResponse(results: Array<string>): HttpResponse {
	return {
		body: { output: { results }, state: "COMPLETE" },
		ok: true,
		status: 200,
	};
}

const UPLOAD_OK: HttpResponse = { body: { versionNumber: 1 }, ok: true, status: 200 };
const TASK_CREATED: HttpResponse = { body: { path: "task-path" }, ok: true, status: 200 };
const TASK_CREATED_WITH_ID: HttpResponse = {
	body: { path: "universes/123/places/456/luau-execution-session-tasks/task-id" },
	ok: true,
	status: 200,
};
const PROCESSING: HttpResponse = { body: { state: "PROCESSING" }, ok: true, status: 200 };

describe(OpenCloudBackend, () => {
	const credentials = {
		apiKey: "test-api-key",
		placeId: "456",
		universeId: "123",
	};

	const options = {
		config: {
			...DEFAULT_CONFIG,
			cache: false,
			placeFile: "./test.rbxl",
		},
		testFiles: ["src/test.spec.ts"],
	} satisfies BackendOptions;

	it("should use default sleep when no sleep option provided", async () => {
		expect.assertions(1);

		vi.useFakeTimers();

		const mockHttp = createMockHttpClient(
			new Map<string, Array<HttpResponse> | HttpResponse>([
				["/versions", UPLOAD_OK],
				["task-path", [PROCESSING, completeResponse([successResult()])]],
				[LUAU_EXEC_TASKS_PATH, TASK_CREATED],
			]),
		);

		const backend = new OpenCloudBackend(credentials, {
			http: mockHttp,
			readFile: () => buffer.Buffer.from("mock-rbxl"),
		});

		const promise = backend.runTests(options);
		await vi.advanceTimersByTimeAsync(10_000);

		const result = await promise;

		expect(result.result.success).toBeTrue();

		vi.useRealTimers();
	});

	it("should upload place file then create execution task", async () => {
		expect.assertions(4);

		const mockHttp = createMockHttpClient(
			new Map([
				["/versions", UPLOAD_OK],
				["task-id", completeResponse([successResult()])],
				[LUAU_EXEC_TASKS_PATH, TASK_CREATED_WITH_ID],
			]),
		);

		const backend = new OpenCloudBackend(credentials, {
			http: mockHttp,
			readFile: () => buffer.Buffer.from("mock-rbxl"),
			sleep: noSleep,
		});

		const result = await backend.runTests(options);

		expect(mockHttp.calls).toHaveLength(3);
		expect(mockHttp.calls[0]!.url).toContain("/versions");
		expect(mockHttp.calls[1]!.url).toContain(LUAU_EXEC_TASKS_PATH);
		expect(result.result.success).toBeTrue();
	});

	it("should pass through game output from results[1]", async () => {
		expect.assertions(1);

		const gameOutputData = JSON.stringify([
			{ message: "Hello from game", messageType: 0, timestamp: 1000 },
		]);

		const mockHttp = createMockHttpClient(
			new Map([
				["/versions", UPLOAD_OK],
				["task-id", completeResponse([successResult(), gameOutputData])],
				[LUAU_EXEC_TASKS_PATH, TASK_CREATED_WITH_ID],
			]),
		);

		const backend = new OpenCloudBackend(credentials, {
			http: mockHttp,
			readFile: () => buffer.Buffer.from("mock-rbxl"),
			sleep: noSleep,
		});

		const result = await backend.runTests(options);

		expect(result.gameOutput).toBe(gameOutputData);
	});

	it("should poll until task is complete", async () => {
		expect.assertions(1);

		const mockHttp = createMockHttpClient(
			new Map<string, Array<HttpResponse> | HttpResponse>([
				["/versions", UPLOAD_OK],
				["task-path", [PROCESSING, PROCESSING, completeResponse([emptySuccessResult()])]],
				[LUAU_EXEC_TASKS_PATH, TASK_CREATED],
			]),
		);

		const backend = new OpenCloudBackend(credentials, {
			http: mockHttp,
			readFile: () => buffer.Buffer.from("mock"),
			sleep: noSleep,
		});

		await backend.runTests(options);

		const pollCalls = mockHttp.calls.filter((call) => call.url.includes("task-path"));

		expect(pollCalls).toHaveLength(3);
	});

	it("should throw on API error", async () => {
		expect.assertions(1);

		const mockHttp = createMockHttpClient(
			new Map([["/versions", { body: { error: "Unauthorized" }, ok: false, status: 401 }]]),
		);

		const backend = new OpenCloudBackend(credentials, {
			http: mockHttp,
			readFile: () => buffer.Buffer.from("mock"),
			sleep: noSleep,
		});

		await expect(backend.runTests(options)).rejects.toThrowWithMessage(
			Error,
			/Failed to upload place/,
		);
	});

	it("should throw on execution failure", async () => {
		expect.assertions(1);

		const mockHttp = createMockHttpClient(
			new Map([
				["/versions", UPLOAD_OK],
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

		const backend = new OpenCloudBackend(credentials, {
			http: mockHttp,
			readFile: () => buffer.Buffer.from("mock"),
			sleep: noSleep,
		});

		await expect(backend.runTests(options)).rejects.toThrowWithMessage(Error, "Script error");
	});

	it("should skip upload when cache hit and return uploadCached true", async () => {
		expect.assertions(4);

		const mockHttp = createMockHttpClient(
			new Map([
				["/versions", UPLOAD_OK],
				["task-id", completeResponse([successResult()])],
				[LUAU_EXEC_TASKS_PATH, TASK_CREATED_WITH_ID],
			]),
		);

		const cacheOptions: BackendOptions = {
			config: {
				...DEFAULT_CONFIG,
				cache: true,
				placeFile: "./test.rbxl",
			},
			testFiles: ["src/test.spec.ts"],
		};

		const uniqueContent = `cache-test-${Date.now()}`;

		const backend = new OpenCloudBackend(credentials, {
			http: mockHttp,
			readFile: () => buffer.Buffer.from(uniqueContent),
			sleep: noSleep,
		});

		const result1 = await backend.runTests(cacheOptions);

		expect(result1.timing.uploadCached).toBeFalse();
		expect(mockHttp.calls.filter((call) => call.url.includes("/versions"))).toHaveLength(1);

		const result2 = await backend.runTests(cacheOptions);

		expect(result2.timing.uploadCached).toBeTrue();
		expect(mockHttp.calls.filter((call) => call.url.includes("/versions"))).toHaveLength(1);
	});

	it("should return uploadCached false when cache disabled", async () => {
		expect.assertions(1);

		const mockHttp = createMockHttpClient(
			new Map([
				["/versions", UPLOAD_OK],
				["task-id", completeResponse([successResult()])],
				[LUAU_EXEC_TASKS_PATH, TASK_CREATED_WITH_ID],
			]),
		);

		const backend = new OpenCloudBackend(credentials, {
			http: mockHttp,
			readFile: () => buffer.Buffer.from("no-cache-test"),
			sleep: noSleep,
		});

		const result = await backend.runTests(options);

		expect(result.timing.uploadCached).toBeFalse();
	});

	it("should retry on 429 rate limit then succeed", async () => {
		expect.assertions(2);

		const mockHttp = createMockHttpClient(
			new Map<string, Array<HttpResponse> | HttpResponse>([
				["/versions", UPLOAD_OK],
				[
					"task-path",
					[
						{ body: {}, headers: { "retry-after": "1" }, ok: false, status: 429 },
						completeResponse([successResult()]),
					],
				],
				[LUAU_EXEC_TASKS_PATH, TASK_CREATED],
			]),
		);

		const sleepCalls: Array<number> = [];
		const backend = new OpenCloudBackend(credentials, {
			http: mockHttp,
			readFile: () => buffer.Buffer.from("mock"),
			sleep: async (ms) => {
				sleepCalls.push(ms);
			},
		});

		const result = await backend.runTests(options);

		expect(result.result.success).toBeTrue();
		// 1 second * 1000
		expect(sleepCalls[0]).toBe(1000);
	});

	it("should throw after exceeding max rate limit retries", async () => {
		expect.assertions(1);

		const mockHttp = createMockHttpClient(
			new Map([
				["/versions", UPLOAD_OK],
				["task-path", { body: {}, headers: {}, ok: false, status: 429 }],
				[LUAU_EXEC_TASKS_PATH, TASK_CREATED],
			]),
		);

		const backend = new OpenCloudBackend(credentials, {
			http: mockHttp,
			readFile: () => buffer.Buffer.from("mock"),
			sleep: noSleep,
		});

		await expect(backend.runTests(options)).rejects.toThrow(
			"Rate limited by Open Cloud API after multiple retries",
		);
	});

	it("should throw on CANCELLED task state", async () => {
		expect.assertions(1);

		const mockHttp = createMockHttpClient(
			new Map([
				["/versions", UPLOAD_OK],
				["task-path", { body: { state: "CANCELLED" }, ok: true, status: 200 }],
				[LUAU_EXEC_TASKS_PATH, TASK_CREATED],
			]),
		);

		const backend = new OpenCloudBackend(credentials, {
			http: mockHttp,
			readFile: () => buffer.Buffer.from("mock"),
			sleep: noSleep,
		});

		await expect(backend.runTests(options)).rejects.toThrowWithMessage(
			Error,
			"Execution was cancelled",
		);
	});

	it("should throw when COMPLETE but output has no results", async () => {
		expect.assertions(1);

		const mockHttp = createMockHttpClient(
			new Map([
				["/versions", UPLOAD_OK],
				[
					"task-path",
					{ body: { output: { results: [] }, state: "COMPLETE" }, ok: true, status: 200 },
				],
				[LUAU_EXEC_TASKS_PATH, TASK_CREATED],
			]),
		);

		const backend = new OpenCloudBackend(credentials, {
			http: mockHttp,
			readFile: () => buffer.Buffer.from("mock"),
			sleep: noSleep,
		});

		await expect(backend.runTests(options)).rejects.toThrowWithMessage(
			Error,
			/No test results in output/,
		);
	});

	it("should throw when execution times out", async () => {
		expect.assertions(1);

		const mockHttp = createMockHttpClient(
			new Map([
				["/versions", UPLOAD_OK],
				["task-path", PROCESSING],
				[LUAU_EXEC_TASKS_PATH, TASK_CREATED],
			]),
		);

		const timeoutOptions = {
			config: {
				...DEFAULT_CONFIG,
				cache: false,
				placeFile: "./test.rbxl",
				timeout: 1,
			},
			testFiles: ["src/test.spec.ts"],
		} satisfies BackendOptions;

		const backend = new OpenCloudBackend(credentials, {
			http: mockHttp,
			readFile: () => buffer.Buffer.from("mock"),
			sleep: noSleep,
		});

		await expect(backend.runTests(timeoutOptions)).rejects.toThrowWithMessage(
			Error,
			"Execution timed out",
		);
	});

	it("should throw on task creation failure", async () => {
		expect.assertions(1);

		const mockHttp = createMockHttpClient(
			new Map([
				["/versions", UPLOAD_OK],
				[LUAU_EXEC_TASKS_PATH, { body: { error: "Bad request" }, ok: false, status: 400 }],
			]),
		);

		const backend = new OpenCloudBackend(credentials, {
			http: mockHttp,
			readFile: () => buffer.Buffer.from("mock"),
			sleep: noSleep,
		});

		await expect(backend.runTests(options)).rejects.toThrowWithMessage(
			Error,
			"Failed to create execution task: 400",
		);
	});

	it("should throw when poll response is not ok", async () => {
		expect.assertions(1);

		const mockHttp = createMockHttpClient(
			new Map([
				["/versions", UPLOAD_OK],
				["task-path", { body: { error: "Internal error" }, ok: false, status: 500 }],
				[LUAU_EXEC_TASKS_PATH, TASK_CREATED],
			]),
		);

		const backend = new OpenCloudBackend(credentials, {
			http: mockHttp,
			readFile: () => buffer.Buffer.from("mock"),
			sleep: noSleep,
		});

		await expect(backend.runTests(options)).rejects.toThrowWithMessage(
			Error,
			"Failed to poll task: 500",
		);
	});

	it("should use fallback message when error has no message field", async () => {
		expect.assertions(1);

		const mockHttp = createMockHttpClient(
			new Map([
				["/versions", UPLOAD_OK],
				["task-path", { body: { error: {}, state: "FAILED" }, ok: true, status: 200 }],
				[LUAU_EXEC_TASKS_PATH, TASK_CREATED],
			]),
		);

		const backend = new OpenCloudBackend(credentials, {
			http: mockHttp,
			readFile: () => buffer.Buffer.from("mock"),
			sleep: noSleep,
		});

		await expect(backend.runTests(options)).rejects.toThrowWithMessage(
			Error,
			"Execution failed",
		);
	});

	it("should use default retry wait when retry-after is invalid", async () => {
		expect.assertions(1);

		const mockHttp = createMockHttpClient(
			new Map<string, Array<HttpResponse> | HttpResponse>([
				["/versions", UPLOAD_OK],
				[
					"task-path",
					[
						{
							body: {},
							headers: { "retry-after": "not-a-number" },
							ok: false,
							status: 429,
						},
						completeResponse([emptySuccessResult()]),
					],
				],
				[LUAU_EXEC_TASKS_PATH, TASK_CREATED],
			]),
		);

		const sleepCalls: Array<number> = [];
		const backend = new OpenCloudBackend(credentials, {
			http: mockHttp,
			readFile: () => buffer.Buffer.from("mock"),
			sleep: async (ms) => {
				sleepCalls.push(ms);
			},
		});

		await backend.runTests(options);

		expect(sleepCalls[0]).toBe(5000);
	});

	it("should attach gameOutput to LuauScriptError from parseJestOutput", async () => {
		expect.assertions(2);

		const luauError = JSON.stringify({ err: "Luau script error", success: false });
		const gameOutputData = JSON.stringify([
			{ message: "Error context", messageType: 0, timestamp: 1000 },
		]);

		const mockHttp = createMockHttpClient(
			new Map([
				["/versions", UPLOAD_OK],
				["task-id", completeResponse([luauError, gameOutputData])],
				[LUAU_EXEC_TASKS_PATH, TASK_CREATED_WITH_ID],
			]),
		);

		const backend = new OpenCloudBackend(credentials, {
			http: mockHttp,
			readFile: () => buffer.Buffer.from("mock"),
			sleep: noSleep,
		});

		const error = await backend.runTests(options).catch((err: unknown) => err);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error & { gameOutput?: string }).gameOutput).toBe(gameOutputData);
	});

	it("should rethrow non-LuauScriptError from parseJestOutput without gameOutput", async () => {
		expect.assertions(1);

		const mockHttp = createMockHttpClient(
			new Map([
				["/versions", UPLOAD_OK],
				["task-id", completeResponse(["{bad json"])],
				[LUAU_EXEC_TASKS_PATH, TASK_CREATED_WITH_ID],
			]),
		);

		const backend = new OpenCloudBackend(credentials, {
			http: mockHttp,
			readFile: () => buffer.Buffer.from("mock"),
			sleep: noSleep,
		});

		await expect(backend.runTests(options)).rejects.toThrow(SyntaxError);
	});

	it("should use default retry wait when retry-after header missing", async () => {
		expect.assertions(1);

		const mockHttp = createMockHttpClient(
			new Map<string, Array<HttpResponse> | HttpResponse>([
				["/versions", UPLOAD_OK],
				[
					"task-path",
					[
						{ body: {}, ok: false, status: 429 },
						completeResponse([emptySuccessResult()]),
					],
				],
				[LUAU_EXEC_TASKS_PATH, TASK_CREATED],
			]),
		);

		const sleepCalls: Array<number> = [];
		const backend = new OpenCloudBackend(credentials, {
			http: mockHttp,
			readFile: () => buffer.Buffer.from("mock"),
			sleep: async (ms) => {
				sleepCalls.push(ms);
			},
		});

		await backend.runTests(options);

		// Default wait is 5000ms when no retry-after header
		expect(sleepCalls[0]).toBe(5000);
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

describe(createOpenCloudBackend, () => {
	it("should throw when ROBLOX_OPEN_CLOUD_API_KEY is missing", () => {
		expect.assertions(1);

		withEnvironmentBackup(() => {
			delete process.env["ROBLOX_OPEN_CLOUD_API_KEY"];
			delete process.env["ROBLOX_UNIVERSE_ID"];
			delete process.env["ROBLOX_PLACE_ID"];

			expect(() => createOpenCloudBackend()).toThrow(
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

			expect(() => createOpenCloudBackend()).toThrow(
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

			expect(() => createOpenCloudBackend()).toThrow(
				"ROBLOX_PLACE_ID environment variable is required",
			);
		});
	});

	it("should create backend when all env vars are set", () => {
		expect.assertions(1);

		withEnvironmentBackup(() => {
			process.env["ROBLOX_OPEN_CLOUD_API_KEY"] = "key";
			process.env["ROBLOX_UNIVERSE_ID"] = "123";
			process.env["ROBLOX_PLACE_ID"] = "456";

			const backend = createOpenCloudBackend();

			expect(backend).toBeInstanceOf(OpenCloudBackend);
		});
	});
});
