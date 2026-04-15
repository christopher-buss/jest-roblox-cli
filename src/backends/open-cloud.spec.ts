import buffer from "node:buffer";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../config/schema.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import type { HttpClient, HttpResponse } from "./http-client.ts";
import type { BackendOptions, ProjectJob } from "./interface.ts";
import { createOpenCloudBackend, OpenCloudBackend } from "./open-cloud.ts";

const LUAU_EXEC_TASKS_PATH = "/luau-execution-session-tasks";

interface MockCall {
	body?: unknown;
	method: string;
	url: string;
}

type TaskHandler = (body: unknown) => {
	complete: HttpResponse;
	processing?: Array<HttpResponse>;
	taskPath: string;
};

interface DispatchMockOptions {
	onCreateTask: TaskHandler;
	uploadResponse?: HttpResponse;
}

const UPLOAD_OK: HttpResponse = { body: { versionNumber: 1 }, ok: true, status: 200 };

function createDispatchMock(options: DispatchMockOptions): HttpClient & {
	calls: Array<MockCall>;
	createCallCount: number;
} {
	const calls: Array<MockCall> = [];
	// Each created task path gets its own queue of poll responses. Multiple
	// parallel buckets issue distinct task paths and are polled independently.
	const pollQueues = new Map<string, Array<HttpResponse>>();
	let createCallCount = 0;

	const client: HttpClient & { calls: Array<MockCall>; createCallCount: number } = {
		calls,
		createCallCount,
		async request(method, url, requestOptions) {
			calls.push({ body: requestOptions?.body, method, url });

			if (url.includes("/versions")) {
				return options.uploadResponse ?? UPLOAD_OK;
			}

			if (url.includes(LUAU_EXEC_TASKS_PATH) && method === "POST") {
				createCallCount++;
				client.createCallCount = createCallCount;
				const handled = options.onCreateTask(requestOptions?.body);
				const queue = [...(handled.processing ?? []), handled.complete];
				pollQueues.set(handled.taskPath, queue);
				return { body: { path: handled.taskPath }, ok: true, status: 200 };
			}

			for (const [taskPath, queue] of pollQueues) {
				if (url.includes(taskPath)) {
					const next = queue.shift() ?? queue[queue.length - 1];
					if (queue.length === 0 && next !== undefined) {
						queue.push(next);
					}

					return next ?? { body: {}, ok: false, status: 500 };
				}
			}

			return { body: { error: "Not found" }, ok: false, status: 404 };
		},
	};

	return client;
}

async function noSleep(): Promise<void> {}

function successJest(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		numFailedTests: 0,
		numPassedTests: 1,
		numPendingTests: 0,
		numTotalTests: 1,
		startTime: 0,
		success: true,
		testResults: [],
		...overrides,
	});
}

function envelope(
	entries: Array<{ elapsedMs?: number; gameOutput?: string; jestOutput: string }>,
): string {
	return JSON.stringify({ entries });
}

function completeResponse(jestOutput: string, gameOutput = "[]"): HttpResponse {
	return {
		body: { output: { results: [jestOutput, gameOutput] }, state: "COMPLETE" },
		ok: true,
		status: 200,
	};
}

function job(displayName: string, overrides: Partial<ResolvedConfig> = {}): ProjectJob {
	return {
		config: {
			...DEFAULT_CONFIG,
			cache: false,
			placeFile: "./test.rbxl",
			...overrides,
		},
		displayColor: `${displayName}-color`,
		displayName,
		testFiles: [`${displayName}/test.spec.ts`],
	};
}

function jobsOptions(
	jobs: Array<ProjectJob>,
	parallel?: BackendOptions["parallel"],
): BackendOptions {
	return parallel === undefined ? { jobs } : { jobs, parallel };
}

const credentials = {
	apiKey: "test-api-key",
	placeId: "456",
	universeId: "123",
};

describe(OpenCloudBackend, () => {
	it("should throw when the jobs array is empty", async () => {
		expect.assertions(1);

		const backend = new OpenCloudBackend(credentials, {
			http: createDispatchMock({
				onCreateTask: () => {
					return {
						complete: completeResponse(envelope([{ jestOutput: successJest() }])),
						taskPath: "task-empty",
					};
				},
			}),
			readFile: () => buffer.Buffer.from("mock"),
			sleep: noSleep,
		});

		await expect(backend.runTests({ jobs: [] })).rejects.toThrow(
			"OpenCloudBackend requires at least one job",
		);
	});

	it("should default to a single session carrying every job in one configs array", async () => {
		expect.assertions(4);

		const capturedScripts: Array<string> = [];
		const http = createDispatchMock({
			onCreateTask: (body) => {
				capturedScripts.push((body as { script: string }).script);
				return {
					complete: completeResponse(
						envelope([
							{ elapsedMs: 111, jestOutput: successJest({ numPassedTests: 1 }) },
							{ elapsedMs: 222, jestOutput: successJest({ numPassedTests: 2 }) },
							{ elapsedMs: 333, jestOutput: successJest({ numPassedTests: 3 }) },
						]),
					),
					taskPath: "task-single",
				};
			},
		});

		const backend = new OpenCloudBackend(credentials, {
			http,
			readFile: () => buffer.Buffer.from("mock-rbxl"),
			sleep: noSleep,
		});

		const { results } = await backend.runTests(
			jobsOptions([
				job("alpha", { testNamePattern: "alpha-pattern" }),
				job("beta", { testNamePattern: "beta-pattern" }),
				job("gamma", { testNamePattern: "gamma-pattern" }),
			]),
		);

		const capturedPatterns = [
			...(capturedScripts[0] ?? "").matchAll(/"testNamePattern":"([^"]+)"/g),
		].map((match) => match[1]);

		expect(http.createCallCount).toBe(1);
		expect(capturedPatterns).toStrictEqual(["alpha-pattern", "beta-pattern", "gamma-pattern"]);
		expect(results.map((entry) => entry.displayName)).toStrictEqual(["alpha", "beta", "gamma"]);
		expect(results.map((entry) => entry.elapsedMs)).toStrictEqual([111, 222, 333]);
	});

	it("should preserve snapshotFormat per job inside the bundled configs array", async () => {
		expect.assertions(2);

		const capturedScripts: Array<string> = [];
		const http = createDispatchMock({
			onCreateTask: (body) => {
				capturedScripts.push((body as { script: string }).script);
				return {
					complete: completeResponse(
						envelope([{ jestOutput: successJest() }, { jestOutput: successJest() }]),
					),
					taskPath: "task-snapshot",
				};
			},
		});

		const backend = new OpenCloudBackend(credentials, {
			http,
			readFile: () => buffer.Buffer.from("mock-rbxl"),
			sleep: noSleep,
		});

		await backend.runTests(
			jobsOptions([
				job("alpha", {
					snapshotFormat: { escapeString: true, printBasicPrototype: false },
				}),
				job("beta", { snapshotFormat: { escapeString: false, printBasicPrototype: true } }),
			]),
		);

		expect(capturedScripts[0]).toContain('"escapeString":true');
		expect(capturedScripts[0]).toContain('"escapeString":false');
	});

	it("should treat --parallel 1 identically to the default path", async () => {
		expect.assertions(2);

		const http = createDispatchMock({
			onCreateTask: () => {
				return {
					complete: completeResponse(
						envelope([
							{ jestOutput: successJest() },
							{ jestOutput: successJest() },
							{ jestOutput: successJest() },
						]),
					),
					taskPath: "task-parallel-one",
				};
			},
		});

		const backend = new OpenCloudBackend(credentials, {
			http,
			readFile: () => buffer.Buffer.from("mock-rbxl"),
			sleep: noSleep,
		});

		const { results } = await backend.runTests(
			jobsOptions([job("alpha"), job("beta"), job("gamma")], 1),
		);

		expect(http.createCallCount).toBe(1);
		expect(results).toHaveLength(3);
	});

	it("should populate timing.executionMs on the BackendResult", async () => {
		expect.assertions(1);

		const http = createDispatchMock({
			onCreateTask: () => {
				return {
					complete: completeResponse(envelope([{ jestOutput: successJest() }])),
					taskPath: "task-timing",
				};
			},
		});

		const backend = new OpenCloudBackend(credentials, {
			http,
			readFile: () => buffer.Buffer.from("mock-rbxl"),
			sleep: noSleep,
		});

		const { timing } = await backend.runTests(jobsOptions([job("")]));

		expect(timing.executionMs).toBeGreaterThanOrEqual(0);
	});

	it("should fan --parallel 3 out to three concurrent POSTs, one bucket each", async () => {
		expect.assertions(5);

		const capturedScripts: Array<string> = [];
		let inflight = 0;
		let peakInflight = 0;

		const http = createDispatchMock({
			onCreateTask: (body) => {
				capturedScripts.push((body as { script: string }).script);
				inflight++;
				peakInflight = Math.max(peakInflight, inflight);
				const bucketIndex = capturedScripts.length - 1;
				return {
					complete: completeResponse(
						envelope([
							{
								elapsedMs: bucketIndex * 10,
								jestOutput: successJest({ numPassedTests: bucketIndex + 1 }),
							},
						]),
					),
					taskPath: `task-parallel-${bucketIndex.toString()}`,
				};
			},
		});

		// Wrap the http client to decrement inflight on poll completion so peak
		// reflects concurrent task-creation calls.
		const originalRequest = http.request.bind(http);
		http.request = async (method, url, options) => {
			const response = await originalRequest(method, url, options);
			if (url.includes(LUAU_EXEC_TASKS_PATH) && method !== "POST") {
				inflight--;
			}

			return response;
		};

		const backend = new OpenCloudBackend(credentials, {
			http,
			readFile: () => buffer.Buffer.from("mock-rbxl"),
			sleep: noSleep,
		});

		const { results } = await backend.runTests(
			jobsOptions([job("alpha"), job("beta"), job("gamma")], 3),
		);

		expect(http.createCallCount).toBe(3);
		expect(peakInflight).toBe(3);
		expect(results).toHaveLength(3);
		// Each bucket carries exactly one config.
		expect(capturedScripts.every((script) => script.includes('"configs":['))).toBeTrue();
		expect(results.map((entry) => entry.displayName)).toStrictEqual(["alpha", "beta", "gamma"]);
	});

	it("should round-robin 10 jobs into buckets of 4/3/3 and flatten in input order", async () => {
		expect.assertions(5);

		const bucketPatterns: Array<Array<string>> = [];
		const http = createDispatchMock({
			onCreateTask: (body) => {
				const { script } = body as { script: string };
				const patternMatches = [...script.matchAll(/"testNamePattern":"([^"]+)"/g)].map(
					(match) => match[1]!,
				);
				bucketPatterns.push(patternMatches);
				const bucketIndex = bucketPatterns.length - 1;
				const entries = patternMatches.map((_, positionInBucket) => {
					return {
						jestOutput: successJest({
							numPassedTests: bucketIndex * 10 + positionInBucket,
						}),
					};
				});
				return {
					complete: completeResponse(envelope(entries)),
					taskPath: `task-rr-${bucketIndex.toString()}`,
				};
			},
		});

		const backend = new OpenCloudBackend(credentials, {
			http,
			readFile: () => buffer.Buffer.from("mock-rbxl"),
			sleep: noSleep,
		});

		const jobs = Array.from({ length: 10 }, (_, index) => {
			return job(`p${index.toString()}`, { testNamePattern: `pattern-${index.toString()}` });
		});

		const { results } = await backend.runTests(jobsOptions(jobs, 3));

		expect(http.createCallCount).toBe(3);
		// Round-robin: bucket 0 = [0,3,6,9], bucket 1 = [1,4,7], bucket 2 =
		// [2,5,8]
		expect(bucketPatterns[0]).toStrictEqual([
			"pattern-0",
			"pattern-3",
			"pattern-6",
			"pattern-9",
		]);
		expect(bucketPatterns[1]).toStrictEqual(["pattern-1", "pattern-4", "pattern-7"]);
		expect(bucketPatterns[2]).toStrictEqual(["pattern-2", "pattern-5", "pattern-8"]);
		expect(results.map((entry) => entry.displayName)).toStrictEqual([
			"p0",
			"p1",
			"p2",
			"p3",
			"p4",
			"p5",
			"p6",
			"p7",
			"p8",
			"p9",
		]);
	});

	it("should resolve --parallel auto to min(jobs.length, 3)", async () => {
		expect.assertions(1);

		const http = createDispatchMock({
			onCreateTask: (body) => {
				const patterns = [
					...(body as { script: string }).script.matchAll(/"testNamePattern":"([^"]+)"/g),
				];
				return {
					complete: completeResponse(
						envelope(patterns.map(() => ({ jestOutput: successJest() }))),
					),
					taskPath: `task-auto-${Math.random().toString()}`,
				};
			},
		});

		const backend = new OpenCloudBackend(credentials, {
			http,
			readFile: () => buffer.Buffer.from("mock-rbxl"),
			sleep: noSleep,
		});

		const jobs = Array.from({ length: 5 }, (_, index) => {
			return job(`p${index.toString()}`, { testNamePattern: `auto-${index.toString()}` });
		});

		await backend.runTests(jobsOptions(jobs, "auto"));

		expect(http.createCallCount).toBe(3);
	});

	it("should cap --parallel auto at jobs.length when jobs are fewer than the auto ceiling", async () => {
		expect.assertions(1);

		const http = createDispatchMock({
			onCreateTask: () => {
				return {
					complete: completeResponse(envelope([{ jestOutput: successJest() }])),
					taskPath: `task-auto-small-${Math.random().toString()}`,
				};
			},
		});

		const backend = new OpenCloudBackend(credentials, {
			http,
			readFile: () => buffer.Buffer.from("mock-rbxl"),
			sleep: noSleep,
		});

		await backend.runTests(jobsOptions([job("alpha"), job("beta")], "auto"));

		expect(http.createCallCount).toBe(2);
	});

	it("should cap --parallel n at jobs.length when n exceeds the job count", async () => {
		expect.assertions(1);

		const http = createDispatchMock({
			onCreateTask: () => {
				return {
					complete: completeResponse(envelope([{ jestOutput: successJest() }])),
					taskPath: `task-cap-${Math.random().toString()}`,
				};
			},
		});

		const backend = new OpenCloudBackend(credentials, {
			http,
			readFile: () => buffer.Buffer.from("mock-rbxl"),
			sleep: noSleep,
		});

		await backend.runTests(jobsOptions([job("alpha"), job("beta")], 10));

		expect(http.createCallCount).toBe(2);
	});

	it("should throw when --parallel is less than 1", async () => {
		expect.assertions(1);

		const backend = new OpenCloudBackend(credentials, {
			http: createDispatchMock({
				onCreateTask: () => {
					return {
						complete: completeResponse(envelope([{ jestOutput: successJest() }])),
						taskPath: "task-invalid",
					};
				},
			}),
			readFile: () => buffer.Buffer.from("mock"),
			sleep: noSleep,
		});

		await expect(backend.runTests(jobsOptions([job("alpha")], 0))).rejects.toThrow(
			/--parallel must be >= 1/,
		);
	});

	it("should upload the place file exactly once regardless of bucket count", async () => {
		expect.assertions(2);

		const http = createDispatchMock({
			onCreateTask: () => {
				return {
					complete: completeResponse(envelope([{ jestOutput: successJest() }])),
					taskPath: `task-upload-${Math.random().toString()}`,
				};
			},
		});

		let readCalls = 0;
		const backend = new OpenCloudBackend(credentials, {
			http,
			readFile: () => {
				readCalls++;
				return buffer.Buffer.from("mock-rbxl");
			},
			sleep: noSleep,
		});

		await backend.runTests(
			jobsOptions([job("alpha"), job("beta"), job("gamma"), job("delta")], 4),
		);

		const uploadCalls = http.calls.filter((call) => call.url.includes("/versions"));

		expect(uploadCalls).toHaveLength(1);
		expect(readCalls).toBe(1);
	});

	it("should reject the whole call when any parallel bucket fails first", async () => {
		expect.assertions(1);

		const http = createDispatchMock({
			onCreateTask: () => {
				const bucketIndex = http.createCallCount;
				if (bucketIndex === 2) {
					return {
						complete: {
							body: { error: { message: "bucket two blew up" }, state: "FAILED" },
							ok: true,
							status: 200,
						},
						taskPath: `task-fail-${bucketIndex.toString()}`,
					};
				}

				return {
					complete: completeResponse(envelope([{ jestOutput: successJest() }])),
					taskPath: `task-fail-${bucketIndex.toString()}`,
				};
			},
		});

		const backend = new OpenCloudBackend(credentials, {
			http,
			readFile: () => buffer.Buffer.from("mock-rbxl"),
			sleep: noSleep,
		});

		await expect(
			backend.runTests(jobsOptions([job("alpha"), job("beta"), job("gamma")], 3)),
		).rejects.toThrowWithMessage(Error, "bucket two blew up");
	});

	it("should pass through per-entry gameOutput from the envelope", async () => {
		expect.assertions(1);

		const entryGameOutput = JSON.stringify([
			{ message: "alpha log", messageType: 0, timestamp: 1 },
		]);

		const http = createDispatchMock({
			onCreateTask: () => {
				return {
					complete: completeResponse(
						envelope([{ gameOutput: entryGameOutput, jestOutput: successJest() }]),
					),
					taskPath: "task-game-output",
				};
			},
		});

		const backend = new OpenCloudBackend(credentials, {
			http,
			readFile: () => buffer.Buffer.from("mock-rbxl"),
			sleep: noSleep,
		});

		const { results } = await backend.runTests(jobsOptions([job("alpha")]));

		expect(results[0]!.gameOutput).toBe(entryGameOutput);
	});

	it("should fall back to the outer results[1] gameOutput when the entry omits one", async () => {
		expect.assertions(1);

		const fallback = JSON.stringify([{ message: "fallback", messageType: 0, timestamp: 0 }]);

		const http = createDispatchMock({
			onCreateTask: () => {
				return {
					complete: completeResponse(envelope([{ jestOutput: successJest() }]), fallback),
					taskPath: "task-fallback",
				};
			},
		});

		const backend = new OpenCloudBackend(credentials, {
			http,
			readFile: () => buffer.Buffer.from("mock-rbxl"),
			sleep: noSleep,
		});

		const { results } = await backend.runTests(jobsOptions([job("alpha")]));

		expect(results[0]!.gameOutput).toBe(fallback);
	});

	it("should convert _setup seconds into setupMs on the parsed result", async () => {
		expect.assertions(1);

		const jestOutput = JSON.stringify({
			_setup: 0.321,
			success: true,
			value: {
				numFailedTests: 0,
				numPassedTests: 1,
				numPendingTests: 0,
				numTotalTests: 1,
				startTime: 0,
				success: true,
				testResults: [],
			},
		});

		const setupResponse = completeResponse(envelope([{ jestOutput }]));
		const http = createDispatchMock({
			onCreateTask: () => ({ complete: setupResponse, taskPath: "task-setup" }),
		});

		const backend = new OpenCloudBackend(credentials, {
			http,
			readFile: () => buffer.Buffer.from("mock-rbxl"),
			sleep: noSleep,
		});

		const { results } = await backend.runTests(jobsOptions([job("alpha")]));

		expect(results[0]!.setupMs).toBe(321);
	});

	it("should return undefined setupMs when _setup is absent", async () => {
		expect.assertions(1);

		const http = createDispatchMock({
			onCreateTask: () => {
				return {
					complete: completeResponse(envelope([{ jestOutput: successJest() }])),
					taskPath: "task-no-setup",
				};
			},
		});

		const backend = new OpenCloudBackend(credentials, {
			http,
			readFile: () => buffer.Buffer.from("mock-rbxl"),
			sleep: noSleep,
		});

		const { results } = await backend.runTests(jobsOptions([job("alpha")]));

		expect(results[0]!.setupMs).toBeUndefined();
	});

	it("should poll until the task reports COMPLETE", async () => {
		expect.assertions(1);

		const http = createDispatchMock({
			onCreateTask: () => {
				return {
					complete: completeResponse(envelope([{ jestOutput: successJest() }])),
					processing: [
						{ body: { state: "PROCESSING" }, ok: true, status: 200 },
						{ body: { state: "PROCESSING" }, ok: true, status: 200 },
					],
					taskPath: "task-poll",
				};
			},
		});

		const backend = new OpenCloudBackend(credentials, {
			http,
			readFile: () => buffer.Buffer.from("mock-rbxl"),
			sleep: noSleep,
		});

		await backend.runTests(jobsOptions([job("alpha")]));

		const pollCalls = http.calls.filter(
			(call) => call.method === "GET" && call.url.includes("task-poll"),
		);

		expect(pollCalls).toHaveLength(3);
	});

	it("should use the default sleep implementation when none is provided", async () => {
		expect.assertions(1);

		vi.useFakeTimers();

		const http = createDispatchMock({
			onCreateTask: () => {
				return {
					complete: completeResponse(envelope([{ jestOutput: successJest() }])),
					processing: [{ body: { state: "PROCESSING" }, ok: true, status: 200 }],
					taskPath: "task-default-sleep",
				};
			},
		});

		const backend = new OpenCloudBackend(credentials, {
			http,
			readFile: () => buffer.Buffer.from("mock-rbxl"),
		});

		const promise = backend.runTests(jobsOptions([job("alpha")]));

		await vi.advanceTimersByTimeAsync(10_000);

		const { results } = await promise;

		expect(results[0]!.result.success).toBeTrue();

		vi.useRealTimers();
	});

	it("should retry on 429 and honor numeric retry-after", async () => {
		expect.assertions(2);

		const http = createDispatchMock({
			onCreateTask: () => {
				return {
					complete: completeResponse(envelope([{ jestOutput: successJest() }])),
					processing: [
						{ body: {}, headers: { "retry-after": "1" }, ok: false, status: 429 },
					],
					taskPath: "task-429",
				};
			},
		});

		const sleepCalls: Array<number> = [];
		const backend = new OpenCloudBackend(credentials, {
			http,
			readFile: () => buffer.Buffer.from("mock-rbxl"),
			sleep: async (ms) => {
				sleepCalls.push(ms);
			},
		});

		const { results } = await backend.runTests(jobsOptions([job("alpha")]));

		expect(results[0]!.result.success).toBeTrue();
		expect(sleepCalls[0]).toBe(1000);
	});

	it("should use the default retry wait when retry-after is not numeric", async () => {
		expect.assertions(1);

		const http = createDispatchMock({
			onCreateTask: () => {
				return {
					complete: completeResponse(envelope([{ jestOutput: successJest() }])),
					processing: [
						{
							body: {},
							headers: { "retry-after": "not-a-number" },
							ok: false,
							status: 429,
						},
					],
					taskPath: "task-retry-bad",
				};
			},
		});

		const sleepCalls: Array<number> = [];
		const backend = new OpenCloudBackend(credentials, {
			http,
			readFile: () => buffer.Buffer.from("mock-rbxl"),
			sleep: async (ms) => {
				sleepCalls.push(ms);
			},
		});

		await backend.runTests(jobsOptions([job("alpha")]));

		expect(sleepCalls[0]).toBe(5000);
	});

	it("should use the default retry wait when retry-after header is missing", async () => {
		expect.assertions(1);

		const http = createDispatchMock({
			onCreateTask: () => {
				return {
					complete: completeResponse(envelope([{ jestOutput: successJest() }])),
					processing: [{ body: {}, ok: false, status: 429 }],
					taskPath: "task-retry-missing",
				};
			},
		});

		const sleepCalls: Array<number> = [];
		const backend = new OpenCloudBackend(credentials, {
			http,
			readFile: () => buffer.Buffer.from("mock-rbxl"),
			sleep: async (ms) => {
				sleepCalls.push(ms);
			},
		});

		await backend.runTests(jobsOptions([job("alpha")]));

		expect(sleepCalls[0]).toBe(5000);
	});

	it("should throw after exceeding max rate-limit retries", async () => {
		expect.assertions(1);

		const http = createDispatchMock({
			onCreateTask: () => {
				return {
					complete: { body: {}, headers: {}, ok: false, status: 429 },
					taskPath: "task-max-retries",
				};
			},
		});

		const backend = new OpenCloudBackend(credentials, {
			http,
			readFile: () => buffer.Buffer.from("mock-rbxl"),
			sleep: noSleep,
		});

		await expect(backend.runTests(jobsOptions([job("alpha")]))).rejects.toThrow(
			"Rate limited by Open Cloud API after multiple retries",
		);
	});

	it("should throw when the place upload fails", async () => {
		expect.assertions(1);

		const http = createDispatchMock({
			onCreateTask: () => {
				return {
					complete: completeResponse(envelope([{ jestOutput: successJest() }])),
					taskPath: "task-upload-fail",
				};
			},
			uploadResponse: { body: { error: "Unauthorized" }, ok: false, status: 401 },
		});

		const backend = new OpenCloudBackend(credentials, {
			http,
			readFile: () => buffer.Buffer.from("mock-rbxl"),
			sleep: noSleep,
		});

		await expect(backend.runTests(jobsOptions([job("alpha")]))).rejects.toThrowWithMessage(
			Error,
			/Failed to upload place/,
		);
	});

	it("should throw when task creation fails", async () => {
		expect.assertions(1);

		const http: HttpClient = {
			async request(method, url) {
				if (url.includes("/versions")) {
					return UPLOAD_OK;
				}

				if (url.includes(LUAU_EXEC_TASKS_PATH) && method === "POST") {
					return { body: { error: "Bad request" }, ok: false, status: 400 };
				}

				return { body: {}, ok: false, status: 404 };
			},
		};

		const backend = new OpenCloudBackend(credentials, {
			http,
			readFile: () => buffer.Buffer.from("mock-rbxl"),
			sleep: noSleep,
		});

		await expect(backend.runTests(jobsOptions([job("alpha")]))).rejects.toThrowWithMessage(
			Error,
			"Failed to create execution task: 400",
		);
	});

	it("should throw when a poll response is not ok", async () => {
		expect.assertions(1);

		const http = createDispatchMock({
			onCreateTask: () => {
				return {
					complete: { body: { error: "Internal error" }, ok: false, status: 500 },
					taskPath: "task-poll-500",
				};
			},
		});

		const backend = new OpenCloudBackend(credentials, {
			http,
			readFile: () => buffer.Buffer.from("mock-rbxl"),
			sleep: noSleep,
		});

		await expect(backend.runTests(jobsOptions([job("alpha")]))).rejects.toThrowWithMessage(
			Error,
			"Failed to poll task: 500",
		);
	});

	it("should throw on FAILED task state using the error message", async () => {
		expect.assertions(1);

		const http = createDispatchMock({
			onCreateTask: () => {
				return {
					complete: {
						body: { error: { message: "Script error" }, state: "FAILED" },
						ok: true,
						status: 200,
					},
					taskPath: "task-failed",
				};
			},
		});

		const backend = new OpenCloudBackend(credentials, {
			http,
			readFile: () => buffer.Buffer.from("mock-rbxl"),
			sleep: noSleep,
		});

		await expect(backend.runTests(jobsOptions([job("alpha")]))).rejects.toThrowWithMessage(
			Error,
			"Script error",
		);
	});

	it("should fall back on a generic message when FAILED error has no message", async () => {
		expect.assertions(1);

		const http = createDispatchMock({
			onCreateTask: () => {
				return {
					complete: { body: { error: {}, state: "FAILED" }, ok: true, status: 200 },
					taskPath: "task-failed-generic",
				};
			},
		});

		const backend = new OpenCloudBackend(credentials, {
			http,
			readFile: () => buffer.Buffer.from("mock-rbxl"),
			sleep: noSleep,
		});

		await expect(backend.runTests(jobsOptions([job("alpha")]))).rejects.toThrowWithMessage(
			Error,
			"Execution failed",
		);
	});

	it("should throw on CANCELLED task state", async () => {
		expect.assertions(1);

		const http = createDispatchMock({
			onCreateTask: () => {
				return {
					complete: { body: { state: "CANCELLED" }, ok: true, status: 200 },
					taskPath: "task-cancelled",
				};
			},
		});

		const backend = new OpenCloudBackend(credentials, {
			http,
			readFile: () => buffer.Buffer.from("mock-rbxl"),
			sleep: noSleep,
		});

		await expect(backend.runTests(jobsOptions([job("alpha")]))).rejects.toThrowWithMessage(
			Error,
			"Execution was cancelled",
		);
	});

	it("should throw when COMPLETE output has no results", async () => {
		expect.assertions(1);

		const http = createDispatchMock({
			onCreateTask: () => {
				return {
					complete: {
						body: { output: { results: [] }, state: "COMPLETE" },
						ok: true,
						status: 200,
					},
					taskPath: "task-empty-output",
				};
			},
		});

		const backend = new OpenCloudBackend(credentials, {
			http,
			readFile: () => buffer.Buffer.from("mock-rbxl"),
			sleep: noSleep,
		});

		await expect(backend.runTests(jobsOptions([job("alpha")]))).rejects.toThrowWithMessage(
			Error,
			/No test results in output/,
		);
	});

	it("should throw when execution times out", async () => {
		expect.assertions(1);

		const http = createDispatchMock({
			onCreateTask: () => {
				return {
					complete: { body: { state: "PROCESSING" }, ok: true, status: 200 },
					taskPath: "task-timeout",
				};
			},
		});

		const backend = new OpenCloudBackend(credentials, {
			http,
			readFile: () => buffer.Buffer.from("mock-rbxl"),
			sleep: noSleep,
		});

		await expect(
			backend.runTests(jobsOptions([job("alpha", { timeout: 1 })])),
		).rejects.toThrowWithMessage(Error, "Execution timed out");
	});

	it("should attach fallback gameOutput to LuauScriptError from parseJestOutput", async () => {
		expect.assertions(2);

		const luauError = JSON.stringify({ err: "Luau script error", success: false });
		const gameOutputData = JSON.stringify([
			{ message: "error context", messageType: 0, timestamp: 1 },
		]);

		// Legacy-shaped payload (no entries wrapper) is rewrapped by
		// parseEnvelope and parseJestOutput throws a LuauScriptError that picks
		// up the outer gameOutput as fallback.
		const luauResponse = completeResponse(luauError, gameOutputData);
		const http = createDispatchMock({
			onCreateTask: () => ({ complete: luauResponse, taskPath: "task-luau-err" }),
		});

		const backend = new OpenCloudBackend(credentials, {
			http,
			readFile: () => buffer.Buffer.from("mock-rbxl"),
			sleep: noSleep,
		});

		const error = await backend
			.runTests(jobsOptions([job("alpha")]))
			.catch((err: unknown) => err);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error & { gameOutput?: string }).gameOutput).toBe(gameOutputData);
	});

	it("should rethrow non-LuauScriptError exceptions from parseJestOutput", async () => {
		expect.assertions(1);

		// Envelope-shaped payload whose entry jestOutput is invalid JSON surfaces
		// a SyntaxError through parseJestOutput unchanged.
		const http = createDispatchMock({
			onCreateTask: () => {
				return {
					complete: completeResponse(envelope([{ jestOutput: "{bad json" }])),
					taskPath: "task-bad-json",
				};
			},
		});

		const backend = new OpenCloudBackend(credentials, {
			http,
			readFile: () => buffer.Buffer.from("mock-rbxl"),
			sleep: noSleep,
		});

		await expect(backend.runTests(jobsOptions([job("alpha")]))).rejects.toThrow(SyntaxError);
	});

	it("should throw when the bucket envelope length does not match the job count", async () => {
		expect.assertions(1);

		const http = createDispatchMock({
			onCreateTask: () => {
				return {
					complete: completeResponse(
						envelope([{ jestOutput: successJest() }, { jestOutput: successJest() }]),
					),
					taskPath: "task-mismatch",
				};
			},
		});

		const backend = new OpenCloudBackend(credentials, {
			http,
			readFile: () => buffer.Buffer.from("mock-rbxl"),
			sleep: noSleep,
		});

		await expect(backend.runTests(jobsOptions([job("alpha")]))).rejects.toThrow(
			/Open Cloud backend returned 2 entries but bucket had 1 jobs/,
		);
	});

	it("should reuse the upload cache across runs and mark uploadCached true", async () => {
		expect.assertions(4);

		const http = createDispatchMock({
			onCreateTask: () => {
				return {
					complete: completeResponse(envelope([{ jestOutput: successJest() }])),
					taskPath: `task-cache-${Math.random().toString()}`,
				};
			},
		});

		// A unique body guarantees this cache entry is not already present from
		// earlier test runs.
		const uniqueContent = `cache-test-${Date.now().toString()}-${Math.random().toString()}`;
		const backend = new OpenCloudBackend(credentials, {
			http,
			readFile: () => buffer.Buffer.from(uniqueContent),
			sleep: noSleep,
		});

		const first = await backend.runTests(jobsOptions([job("alpha", { cache: true })]));

		expect(first.timing.uploadCached).toBeFalse();
		expect(http.calls.filter((call) => call.url.includes("/versions"))).toHaveLength(1);

		const second = await backend.runTests(jobsOptions([job("alpha", { cache: true })]));

		expect(second.timing.uploadCached).toBeTrue();
		// No second upload call — the first version call is still the only one.
		expect(http.calls.filter((call) => call.url.includes("/versions"))).toHaveLength(1);
	});

	it("should return uploadCached false when cache is disabled", async () => {
		expect.assertions(1);

		const http = createDispatchMock({
			onCreateTask: () => {
				return {
					complete: completeResponse(envelope([{ jestOutput: successJest() }])),
					taskPath: "task-no-cache",
				};
			},
		});

		const backend = new OpenCloudBackend(credentials, {
			http,
			readFile: () => buffer.Buffer.from("no-cache-test"),
			sleep: noSleep,
		});

		const { timing } = await backend.runTests(jobsOptions([job("alpha")]));

		expect(timing.uploadCached).toBeFalse();
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
