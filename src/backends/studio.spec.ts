import { fromExact, fromPartial } from "@total-typescript/shoehorn";

import { type } from "arktype";
import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";

import type { MockWebSocketServer as MockWebSocketServerType } from "../../test/mocks/mock-web-socket-server.ts";
import type { MockWebSocket as MockWebSocketType } from "../../test/mocks/mock-web-socket.ts";
import { DEFAULT_CONFIG } from "../config/schema.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import type { JestResult } from "../types/jest-result.ts";
import type { BackendOptions, ProjectJob } from "./interface.ts";
import { StudioBackend } from "./studio.ts";

const { getLastCreatedServer, MockWebSocket, MockWebSocketServer } = await vi.hoisted(
	async () => import("../../test/mocks/mock-ws"),
);

vi.mock(import("ws"), async () => fromPartial({ WebSocketServer: MockWebSocketServer }));

// Mirrors the wire format StudioBackend emits in `attachSocket` — used by the
// send-mock to assert the backend keeps sending the v2 handshake fields.
// Drift here means the protocol-version handshake regressed.
const pluginRequest = type({
	action: "string",
	config: { configs: "unknown[]" },
	protocolVersion: "number",
	request_id: "string",
});

function job(displayName: string, overrides: Partial<ResolvedConfig> = {}): ProjectJob {
	return {
		config: { ...DEFAULT_CONFIG, backend: "studio", placeFile: "./test.rbxl", ...overrides },
		displayColor: `${displayName}-color`,
		displayName,
		testFiles: [`${displayName}/test.spec.ts`],
	};
}

const singleJobOptions: BackendOptions = { jobs: [job("")] };

interface ReplyOptions {
	entries?: Array<{ elapsedMs?: number; gameOutput?: string; jestOutput: string }>;
	gameOutput?: string;
	rawJestOutput?: string;
}

function successResult(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify(
		fromExact<JestResult>({
			numFailedTests: 0,
			numPassedTests: 2,
			numPendingTests: 0,
			numTotalTests: 2,
			startTime: 0,
			success: true,
			testResults: [],
			...overrides,
		}),
	);
}

function envelope(
	entries: Array<{ elapsedMs?: number; gameOutput?: string; jestOutput: string }>,
): string {
	return JSON.stringify({ entries });
}

function connectAndReply(wss: MockWebSocketServerType, reply: ReplyOptions): MockWebSocketType {
	const socket = new MockWebSocket();

	socket.send.mockImplementation((data) => {
		const message = pluginRequest.assert(JSON.parse(data));
		if (message.action === "run_tests") {
			const jestOutput =
				reply.rawJestOutput ?? envelope(reply.entries ?? [{ jestOutput: successResult() }]);
			queueMicrotask(() => {
				socket.emit(
					"message",
					Buffer.from(
						JSON.stringify({
							gameOutput: reply.gameOutput ?? JSON.stringify([]),
							jestOutput,
							protocolVersion: 2,
							request_id: message.request_id,
							type: "results",
						}),
					),
				);
			});
		}
	});

	wss.emit("connection", socket);
	return socket;
}

describe("protocol version handshake", () => {
	it("should include protocolVersion in the run_tests payload", async () => {
		expect.assertions(1);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTests(singleJobOptions);

		const wss = getLastCreatedServer()!;
		const socket = new MockWebSocket();
		let captured: typeof pluginRequest.infer | undefined;

		socket.send.mockImplementation((data) => {
			captured = pluginRequest.assert(JSON.parse(data));
			queueMicrotask(() => {
				socket.emit(
					"message",
					Buffer.from(
						JSON.stringify({
							gameOutput: "[]",
							jestOutput: envelope([{ elapsedMs: 1, jestOutput: successResult() }]),
							protocolVersion: 2,
							request_id: captured!.request_id,
							type: "results",
						}),
					),
				);
			});
		});

		wss.emit("connection", socket);
		await promise;

		expect(captured?.protocolVersion).toBeTypeOf("number");
	});

	it("should reject a stale v1 plugin response that omits protocolVersion echo", async () => {
		expect.assertions(1);

		// A pre-v2 plugin would ignore the request-side `protocolVersion`
		// and return a valid-looking results envelope without echoing it.
		// Schema rejection on the response surfaces this as the standard
		// "Invalid plugin message" error rather than running with no
		// runtime injection.
		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTests(singleJobOptions);

		const wss = getLastCreatedServer()!;
		const socket = new MockWebSocket();

		socket.send.mockImplementation((data) => {
			const { request_id } = pluginRequest.assert(JSON.parse(data));
			queueMicrotask(() => {
				socket.emit(
					"message",
					Buffer.from(
						JSON.stringify({
							gameOutput: "[]",
							jestOutput: envelope([{ jestOutput: successResult() }]),
							request_id,
							type: "results",
							// no protocolVersion — simulating stale plugin
						}),
					),
				);
			});
		});

		wss.emit("connection", socket);

		await expect(promise).rejects.toThrow(/invalid plugin message/i);
	});

	it("should throw a clear upgrade error on version_mismatch response", async () => {
		expect.assertions(1);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTests(singleJobOptions);

		const wss = getLastCreatedServer()!;
		const socket = new MockWebSocket();

		socket.send.mockImplementation((data) => {
			const { request_id } = pluginRequest.assert(JSON.parse(data));
			queueMicrotask(() => {
				socket.emit(
					"message",
					Buffer.from(
						JSON.stringify({
							actualVersion: 1,
							expectedVersion: 2,
							request_id,
							type: "version_mismatch",
						}),
					),
				);
			});
		});

		wss.emit("connection", socket);

		await expect(promise).rejects.toThrow(/protocol version mismatch/i);
	});
});

describe(StudioBackend, () => {
	it("should send one envelope carrying a configs array with one entry per job", async () => {
		expect.assertions(4);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTests({
			jobs: [
				job("alpha", { testNamePattern: "alpha-pattern" }),
				job("beta", { testNamePattern: "beta-pattern" }),
			],
		});

		const wss = getLastCreatedServer()!;
		const socket = new MockWebSocket();
		let capturedConfig: undefined | { configs: Array<{ testNamePattern?: string }> };

		socket.send.mockImplementation((data) => {
			const message = pluginRequest.assert(JSON.parse(data));
			capturedConfig = message.config as { configs: Array<{ testNamePattern?: string }> };
			queueMicrotask(() => {
				socket.emit(
					"message",
					Buffer.from(
						JSON.stringify({
							gameOutput: "[]",
							jestOutput: envelope([
								{ elapsedMs: 10, jestOutput: successResult() },
								{ elapsedMs: 20, jestOutput: successResult() },
							]),
							protocolVersion: 2,
							request_id: message.request_id,
							type: "results",
						}),
					),
				);
			});
		});

		wss.emit("connection", socket);

		await promise;

		expect(socket.send).toHaveBeenCalledOnce();
		expect(capturedConfig?.configs).toHaveLength(2);
		expect(capturedConfig?.configs[0]?.testNamePattern).toBe("alpha-pattern");
		expect(capturedConfig?.configs[1]?.testNamePattern).toBe("beta-pattern");
	});

	it("should return rawResults in the same order as the submitted jobs", async () => {
		expect.assertions(2);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTests({ jobs: [job("alpha"), job("beta"), job("gamma")] });

		const wss = getLastCreatedServer()!;
		connectAndReply(wss, {
			entries: [
				{ elapsedMs: 11, jestOutput: successResult() },
				{ elapsedMs: 22, jestOutput: successResult() },
				{ elapsedMs: 33, jestOutput: successResult() },
			],
		});

		const { rawResults } = await promise;

		expect(rawResults).toHaveLength(3);
		expect(rawResults.map((raw) => raw.entry.elapsedMs)).toStrictEqual([11, 22, 33]);
	});

	it("should populate timing.executionMs on the BackendResult", async () => {
		expect.assertions(1);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTests(singleJobOptions);

		const wss = getLastCreatedServer()!;
		connectAndReply(wss, {});

		const result = await promise;

		expect(result.timing.executionMs).toBeGreaterThanOrEqual(0);
	});

	it("should surface the fallback gameOutput on each rawResult", async () => {
		expect.assertions(1);

		const fallback = JSON.stringify([{ message: "fallback", messageType: 0, timestamp: 0 }]);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTests(singleJobOptions);

		const wss = getLastCreatedServer()!;
		connectAndReply(wss, { gameOutput: fallback });

		const { rawResults } = await promise;

		expect(rawResults[0]!.fallbackGameOutput).toBe(fallback);
	});

	it("should rewrap legacy plugin error payloads as a single rawResult carrying the raw payload", async () => {
		expect.assertions(2);

		const rawJestOutput = JSON.stringify({
			err: "Failed to find Jest instance",
			success: false,
		});

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTests(singleJobOptions);

		const wss = getLastCreatedServer()!;
		connectAndReply(wss, { rawJestOutput });

		const { rawResults } = await promise;

		expect(rawResults).toHaveLength(1);
		expect(rawResults[0]!.entry.jestOutput).toBe(rawJestOutput);
	});

	it("should rethrow syntax errors when jestOutput is not valid JSON", async () => {
		expect.assertions(1);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTests(singleJobOptions);

		const wss = getLastCreatedServer()!;
		connectAndReply(wss, { rawJestOutput: "{bad json" });

		await expect(promise).rejects.toThrow(SyntaxError);
	});

	it("should throw on connection timeout", async () => {
		expect.assertions(1);

		const backend = new StudioBackend({ port: 0, timeout: 100 });

		await expect(backend.runTests(singleJobOptions)).rejects.toThrow(
			"Timed out waiting for Studio plugin connection",
		);
	});

	it("should throw when the plugin disconnects before sending results", async () => {
		expect.assertions(1);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTests(singleJobOptions);

		const wss = getLastCreatedServer()!;
		const socket = new MockWebSocket();
		wss.emit("connection", socket);

		queueMicrotask(() => {
			socket.emit("close");
		});

		await expect(promise).rejects.toThrowWithMessage(
			Error,
			"Studio plugin disconnected before sending results",
		);
	});

	it("should use a pre-connected socket without waiting for a new connection", async () => {
		expect.assertions(2);

		const wss = new MockWebSocketServer({ port: 0 });
		const socket = new MockWebSocket();

		socket.send.mockImplementation((data) => {
			const message = pluginRequest.assert(JSON.parse(data));
			queueMicrotask(() => {
				socket.emit(
					"message",
					Buffer.from(
						JSON.stringify({
							gameOutput: JSON.stringify([]),
							jestOutput: envelope([
								{
									jestOutput: successResult({
										numPassedTests: 3,
										numTotalTests: 3,
									}),
								},
							]),
							protocolVersion: 2,
							request_id: message.request_id,
							type: "results",
						}),
					),
				);
			});
		});

		const backend = new StudioBackend({
			port: 0,
			preConnected: fromPartial({ server: wss, socket }),
		});

		const { rawResults } = await backend.runTests(singleJobOptions);

		expect(rawResults).toHaveLength(1);
		expect(rawResults[0]!.entry.jestOutput).toContain('"numPassedTests":3');
	});

	it("should reject when the plugin sends a malformed message", async () => {
		expect.assertions(1);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTests(singleJobOptions);

		const wss = getLastCreatedServer()!;
		const socket = new MockWebSocket();

		socket.send.mockImplementation(() => {
			queueMicrotask(() => {
				socket.emit("message", Buffer.from(JSON.stringify({ type: "wrong" })));
			});
		});

		wss.emit("connection", socket);

		await expect(promise).rejects.toThrowWithMessage(Error, /Invalid plugin message/);
	});

	it("should reject when the websocket emits an error", async () => {
		expect.assertions(1);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTests(singleJobOptions);

		const wss = getLastCreatedServer()!;
		const socket = new MockWebSocket();
		wss.emit("connection", socket);

		queueMicrotask(() => {
			socket.emit("error", new Error("socket error"));
		});

		await expect(promise).rejects.toThrowWithMessage(Error, "socket error");
	});

	it("should reject when the server emits an error", async () => {
		expect.assertions(1);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTests(singleJobOptions);

		const wss = getLastCreatedServer()!;

		queueMicrotask(() => {
			wss.emit("error", new Error("server error"));
		});

		await expect(promise).rejects.toThrowWithMessage(Error, "server error");
	});

	it("should ignore messages whose request_id does not match", async () => {
		expect.assertions(1);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTests(singleJobOptions);

		const wss = getLastCreatedServer()!;
		const socket = new MockWebSocket();

		socket.send.mockImplementation((data) => {
			const message = pluginRequest.assert(JSON.parse(data));
			queueMicrotask(() => {
				socket.emit(
					"message",
					Buffer.from(
						JSON.stringify({
							jestOutput: "wrong",
							protocolVersion: 2,
							request_id: "wrong-id",
							type: "results",
						}),
					),
				);
				socket.emit(
					"message",
					Buffer.from(
						JSON.stringify({
							jestOutput: envelope([{ jestOutput: successResult() }]),
							protocolVersion: 2,
							request_id: message.request_id,
							type: "results",
						}),
					),
				);
			});
		});

		wss.emit("connection", socket);

		const { rawResults } = await promise;

		expect(rawResults).toHaveLength(1);
	});

	it("should reuse the same WebSocketServer across successive runTests calls", async () => {
		expect.assertions(2);

		const backend = new StudioBackend({ port: 0 });

		const firstPromise = backend.runTests(singleJobOptions);
		const firstWss = getLastCreatedServer()!;
		connectAndReply(firstWss, {});
		await firstPromise;

		const secondPromise = backend.runTests(singleJobOptions);
		const secondWss = getLastCreatedServer()!;
		connectAndReply(secondWss, {});
		await secondPromise;

		expect(secondWss).toBe(firstWss);
		expect(firstWss.close).not.toHaveBeenCalled();
	});

	it("should throw when the runtime returns more entries than jobs", async () => {
		expect.assertions(1);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTests(singleJobOptions);

		const wss = getLastCreatedServer()!;
		connectAndReply(wss, {
			entries: [{ jestOutput: successResult() }, { jestOutput: successResult() }],
		});

		await expect(promise).rejects.toThrow(
			/Studio backend returned 2 entries but request had 1 jobs/,
		);
	});

	it("should throw when the runtime returns fewer entries than jobs", async () => {
		// Regression: a truncated result set used to silently drop trailing
		// projects from the reporter and exit code — reporting success for a
		// partial run. Length check must be symmetric.
		expect.assertions(1);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTests({ jobs: [job("alpha"), job("beta")] });

		const wss = getLastCreatedServer()!;
		connectAndReply(wss, {
			entries: [{ jestOutput: successResult() }],
		});

		await expect(promise).rejects.toThrow(
			/Studio backend returned 1 entries but request had 2 jobs/,
		);
	});

	it("should terminate the underlying WebSocketServer via close()", async () => {
		expect.assertions(2);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTests(singleJobOptions);
		const wss = getLastCreatedServer()!;
		connectAndReply(wss, {});
		await promise;

		backend.close();

		expect(wss.close).toHaveBeenCalledOnce();

		// A second close() should no-op rather than double-closing.
		backend.close();

		expect(wss.close).toHaveBeenCalledOnce();
	});
});
