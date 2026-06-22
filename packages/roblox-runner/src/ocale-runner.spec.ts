import { OpenCloudError, PollTimeoutError } from "@bedrock-rbx/ocale";
import {
	createFakeHttpClient,
	createFakeSleep,
	type FakeHttpClient,
} from "@bedrock-rbx/ocale/testing";

import buffer from "node:buffer";
import { assert, describe, expect, it, vi } from "vitest";

import { OcaleRunner } from "./ocale-runner.ts";

const RBXL_SIGNATURE = new Uint8Array([
	0x3c, 0x72, 0x6f, 0x62, 0x6c, 0x6f, 0x78, 0x21, 0x89, 0xff, 0x0d, 0x0a, 0x1a, 0x0a,
]);

interface TaskBodyOverrides {
	error?: { code: string; message: string };
	output?: { results: ReadonlyArray<unknown> };
	path?: string;
	state?: "CANCELLED" | "COMPLETE" | "FAILED" | "PROCESSING" | "QUEUED";
}

function taskBody(overrides: TaskBodyOverrides = {}): Record<string, unknown> {
	return {
		createTime: "2026-01-01T00:00:00Z",
		path:
			overrides.path ??
			"universes/123/places/456/versions/1/luau-execution-sessions/session-1/tasks/task-1",
		state: overrides.state ?? "QUEUED",
		updateTime: "2026-01-01T00:00:30Z",
		user: "user-1",
		...(overrides.error !== undefined ? { error: overrides.error } : {}),
		...(overrides.output !== undefined ? { output: overrides.output } : {}),
	};
}

function rbxlBuffer(): buffer.Buffer {
	return buffer.Buffer.from(RBXL_SIGNATURE);
}

function makeRunner(httpClient: FakeHttpClient, readData: buffer.Buffer = rbxlBuffer()) {
	return new OcaleRunner(
		{ apiKey: "test-key", placeId: "456", universeId: "123" },
		{
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
			const result = await runner.uploadPlace({ placeFilePath: "/work/test.rbxl" });

			expect(result.versionNumber).toBe(7);
			expect(http.requests[0]!.request.url).toContain("/places/456/versions");
		});

		it("should request a Saved version type by default", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockResponse({ body: { versionNumber: 1 }, status: 200 });

			const runner = makeRunner(http);
			await runner.uploadPlace({ placeFilePath: "/work/p.rbxl" });

			expect(http.requests[0]!.request.url).toContain("versionType=Saved");
		});

		it("should request a Published version type when publish is true", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockResponse({ body: { versionNumber: 1 }, status: 200 });

			const runner = makeRunner(http);
			await runner.uploadPlace({ placeFilePath: "/work/p.rbxl", publish: true });

			expect(http.requests[0]!.request.url).toContain("versionType=Published");
		});

		it("should send rbxlx format when path extension is .rbxlx", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockResponse({ body: { versionNumber: 1 }, status: 200 });

			const xmlBody = buffer.Buffer.from('<roblox version="4"></roblox>');
			const runner = makeRunner(http, xmlBody);
			await runner.uploadPlace({ placeFilePath: "/work/test.rbxlx" });

			const captured = http.requests[0]!.request;
			const headers = captured.headers ?? {};

			expect(headers["Content-Type"] ?? headers["content-type"]).toMatch(/xml/i);
		});

		it("should always upload on repeat calls with identical bytes", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockResponse({ body: { versionNumber: 1 }, status: 200 });
			http.mockResponse({ body: { versionNumber: 2 }, status: 200 });

			const runner = makeRunner(http);

			await runner.uploadPlace({ placeFilePath: "/work/p.rbxl" });
			await runner.uploadPlace({ placeFilePath: "/work/p.rbxl" });

			expect(http.requests).toHaveLength(2);
		});

		it("should throw when publish returns an API error", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockApiError({ message: "Unauthorized", statusCode: 401 });

			const runner = makeRunner(http);

			await expect(runner.uploadPlace({ placeFilePath: "/work/p.rbxl" })).rejects.toThrow(
				/Unauthorized/,
			);
		});

		it("should preserve the underlying OpenCloudError as cause on the thrown Error from uploadPlace", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockApiError({ message: "Unauthorized", statusCode: 401 });

			const runner = makeRunner(http);

			const caught: unknown = await runner
				.uploadPlace({ placeFilePath: "/work/p.rbxl" })
				.catch((err: unknown) => err);

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
			const result = await runner.uploadPlace({ placeFilePath: "/work/p.rbxl" });

			expect(result.versionNumber).toBe(4);
			expect(http.requests).toHaveLength(2);
		});
	});

	describe("executeScript", () => {
		it("should throw when timeout is not positive", async () => {
			expect.assertions(2);

			const http = createFakeHttpClient();
			const runner = makeRunner(http);

			await expect(runner.executeScript({ script: "return 1", timeout: 0 })).rejects.toThrow(
				"Timeout must be a positive number",
			);
			await expect(
				runner.executeScript({ script: "return 1", timeout: -100 }),
			).rejects.toThrow("Timeout must be a positive number");
		});

		it("should submit, poll, and return string outputs", async () => {
			expect.assertions(2);

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
			const result = await runner.executeScript({ script: "return 1", timeout: 30_000 });

			expect(result.outputs).toStrictEqual(["hello", "world"]);
			expect(result.durationMs).toBeGreaterThanOrEqual(0);
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
			const result = await runner.executeScript({ script: "return 1", timeout: 30_000 });

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
			const result = await runner.executeScript({ script: "return 1", timeout: 30_000 });

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

			const runner = makeRunner(http);

			await expect(
				runner.executeScript({ script: "return 1", timeout: 30_000 }),
			).rejects.toThrow("Script blew up");
		});

		it("should throw 'Execution timed out' with PollTimeoutError as cause when polling exhausts budget", async () => {
			expect.assertions(2);

			let clock = 1_000_000;
			vi.spyOn(Date, "now").mockImplementation(() => clock);
			async function advancingSleep(ms: number): Promise<void> {
				clock += ms;
			}

			const http = createFakeHttpClient();
			http.mockResponse({ body: taskBody({ state: "QUEUED" }), status: 200 });
			http.mockResponse({ body: taskBody({ state: "PROCESSING" }), status: 200 });

			const runner = new OcaleRunner(
				{ apiKey: "test-key", placeId: "456", universeId: "123" },
				{ httpClient: http, readFile: () => rbxlBuffer(), sleep: advancingSleep },
			);

			const caught: unknown = await runner
				.executeScript({ script: "return 1", timeout: 100 })
				.catch((err: unknown) => err);

			assert(caught instanceof Error);

			expect(caught.message).toBe("Execution timed out");
			expect(caught.cause).toBeInstanceOf(PollTimeoutError);
		});

		it("should throw when task is CANCELLED", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockResponse({ body: taskBody({ state: "QUEUED" }), status: 200 });
			http.mockResponse({ body: taskBody({ state: "CANCELLED" }), status: 200 });

			const runner = makeRunner(http);

			await expect(
				runner.executeScript({ script: "return 1", timeout: 30_000 }),
			).rejects.toThrow("Execution was cancelled");
		});

		it("should throw when submit returns API error", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockApiError({ message: "Bad request", statusCode: 400 });

			const runner = makeRunner(http);

			await expect(
				runner.executeScript({ script: "return 1", timeout: 30_000 }),
			).rejects.toThrow(/Bad request/);
		});

		it("should preserve the underlying OpenCloudError as cause on the thrown Error from executeScript", async () => {
			expect.assertions(1);

			const http = createFakeHttpClient();
			http.mockApiError({ message: "Bad request", statusCode: 400 });

			const runner = makeRunner(http);

			const caught: unknown = await runner
				.executeScript({ script: "return 1", timeout: 30_000 })
				.catch((err: unknown) => err);

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
			const result = await runner.executeScript({ script: "return 1", timeout: 30_000 });

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
			const result = await runner.executeScript({ script: "return 1", timeout: 30_000 });

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
			await runner.executeScript({ script: "return 1", timeout: 30_000 });

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
			await runner.executeScript({ placeVersion: 99, script: "return 1", timeout: 30_000 });

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
			await runner.executeScript({ script: "return 1", timeout: 600_000 });

			const submitBody = http.requests[0]!.request.body as Record<string, unknown>;

			expect(submitBody["timeout"]).toBe("300s");
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
				runner.uploadPlace({ placeFilePath: "/nonexistent.rbxl" }),
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
