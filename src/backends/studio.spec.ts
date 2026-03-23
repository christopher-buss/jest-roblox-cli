import { fromExact, fromPartial } from "@total-typescript/shoehorn";

import { type } from "arktype";
import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";

import type { MockWebSocketServer as MockWebSocketServerType } from "../../test/mocks/mock-web-socket-server.ts";
import type { MockWebSocket as MockWebSocketType } from "../../test/mocks/mock-web-socket.ts";
import { DEFAULT_CONFIG } from "../config/schema.ts";
import type { JestResult } from "../types/jest-result.ts";
import type { BackendOptions } from "./interface.ts";
import { StudioBackend } from "./studio.ts";

const { getLastCreatedServer, MockWebSocket, MockWebSocketServer } = await vi.hoisted(
	async () => import("../../test/mocks/mock-ws"),
);

vi.mock(import("ws"), async () => fromPartial({ WebSocketServer: MockWebSocketServer }));

const pluginRequest = type({ action: "string", request_id: "string" });

const options = {
	config: {
		...DEFAULT_CONFIG,
		backend: "studio",
		placeFile: "./test.rbxl",
	},
	testFiles: ["src/test.spec.ts"],
} satisfies BackendOptions;

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

function connectAndReply(
	wss: MockWebSocketServerType,
	jestOutput: string,
	gameOutput?: string,
): MockWebSocketType {
	const socket = new MockWebSocket();

	socket.send.mockImplementation((data) => {
		const message = pluginRequest.assert(JSON.parse(data));
		if (message.action === "run_tests") {
			queueMicrotask(() => {
				socket.emit(
					"message",
					Buffer.from(
						JSON.stringify({
							gameOutput: gameOutput ?? JSON.stringify([]),
							jestOutput,
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

describe(StudioBackend, () => {
	it("should send config and return parsed results", async () => {
		expect.assertions(3);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTests(options);

		const wss = getLastCreatedServer()!;
		connectAndReply(wss, successResult());

		const result = await promise;

		expect(result.result.success).toBeTrue();
		expect(result.result.numPassedTests).toBe(2);
		expect(result.result.numTotalTests).toBe(2);
	});

	it("should pass through game output", async () => {
		expect.assertions(1);

		const gameOutputData = JSON.stringify([
			{ message: "Hello from game", messageType: 0, timestamp: 1000 },
		]);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTests(options);

		const wss = getLastCreatedServer()!;
		connectAndReply(
			wss,
			successResult({ numPassedTests: 1, numTotalTests: 1 }),
			gameOutputData,
		);

		const result = await promise;

		expect(result.gameOutput).toBe(gameOutputData);
	});

	it("should not include upload timing", async () => {
		expect.assertions(2);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTests(options);

		const wss = getLastCreatedServer()!;
		connectAndReply(wss, successResult());

		const result = await promise;

		expect(result.timing.uploadMs).toBeUndefined();
		expect(result.timing.uploadCached).toBeUndefined();
	});

	it("should throw on connection timeout", async () => {
		expect.assertions(1);

		const backend = new StudioBackend({ port: 0, timeout: 100 });

		await expect(backend.runTests(options)).rejects.toThrow(
			"Timed out waiting for Studio plugin connection",
		);
	});

	it("should throw on plugin disconnect", async () => {
		expect.assertions(1);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTests(options);

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

	it("should use pre-connected socket without waiting for new connection", async () => {
		expect.assertions(3);

		const wss = new MockWebSocketServer({ port: 0 });
		const socket = new MockWebSocket();

		socket.send.mockImplementation((data) => {
			const message = pluginRequest.assert(JSON.parse(data));
			if (message.action === "run_tests") {
				queueMicrotask(() => {
					socket.emit(
						"message",
						Buffer.from(
							JSON.stringify({
								gameOutput: JSON.stringify([]),
								jestOutput: successResult({ numPassedTests: 3, numTotalTests: 3 }),
								request_id: message.request_id,
								type: "results",
							}),
						),
					);
				});
			}
		});

		const backend = new StudioBackend({
			port: 0,
			preConnected: fromPartial({ server: wss, socket }),
		});

		const result = await backend.runTests(options);

		expect(result.result.success).toBeTrue();
		expect(result.result.numPassedTests).toBe(3);
		expect(result.result.numTotalTests).toBe(3);
	});

	it("should thread coverageData through result", async () => {
		expect.assertions(1);

		const coverageData = {
			"shared/player.luau": { b: undefined, f: undefined, s: { "1": 3, "2": 0 } },
		};

		const jestOutput = JSON.stringify({
			_coverage: coverageData,
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

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTests(options);

		const wss = getLastCreatedServer()!;
		connectAndReply(wss, jestOutput);

		const result = await promise;

		expect(result.coverageData).toStrictEqual(coverageData);
	});

	it("should reject when plugin sends malformed message", async () => {
		expect.assertions(1);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTests(options);

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

	it("should reject when websocket emits error", async () => {
		expect.assertions(1);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTests(options);

		const wss = getLastCreatedServer()!;
		const socket = new MockWebSocket();
		wss.emit("connection", socket);

		queueMicrotask(() => {
			socket.emit("error", new Error("socket error"));
		});

		await expect(promise).rejects.toThrowWithMessage(Error, "socket error");
	});

	it("should reject when server emits error", async () => {
		expect.assertions(1);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTests(options);

		const wss = getLastCreatedServer()!;

		queueMicrotask(() => {
			wss.emit("error", new Error("server error"));
		});

		await expect(promise).rejects.toThrowWithMessage(Error, "server error");
	});

	it("should ignore messages with mismatched request ID", async () => {
		expect.assertions(1);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTests(options);

		const wss = getLastCreatedServer()!;
		const socket = new MockWebSocket();

		socket.send.mockImplementation((data) => {
			const message = pluginRequest.assert(JSON.parse(data));
			if (message.action === "run_tests") {
				queueMicrotask(() => {
					// First: wrong request_id — should be ignored
					socket.emit(
						"message",
						Buffer.from(
							JSON.stringify({
								jestOutput: "wrong",
								request_id: "wrong-id",
								type: "results",
							}),
						),
					);
					// Then: correct request_id
					socket.emit(
						"message",
						Buffer.from(
							JSON.stringify({
								jestOutput: successResult(),
								request_id: message.request_id,
								type: "results",
							}),
						),
					);
				});
			}
		});

		wss.emit("connection", socket);

		const result = await promise;

		expect(result.result.success).toBeTrue();
	});

	it("should rethrow non-LuauScriptError from parseJestOutput", async () => {
		expect.assertions(1);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTests(options);

		const wss = getLastCreatedServer()!;
		connectAndReply(wss, "{bad json");

		await expect(promise).rejects.toThrow(SyntaxError);
	});

	it("should throw when plugin returns error", async () => {
		expect.assertions(1);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTests(options);

		const wss = getLastCreatedServer()!;
		connectAndReply(
			wss,
			JSON.stringify({ err: "Failed to find Jest instance", success: false }),
		);

		await expect(promise).rejects.toThrowWithMessage(Error, "Failed to find Jest instance");
	});
});
