import { type } from "arktype";
import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";

import type { MockWebSocketServer as MockWebSocketServerType } from "../test/mocks/mock-web-socket-server.ts";
import type { MockWebSocket as MockWebSocketType } from "../test/mocks/mock-web-socket.ts";
import { StudioRunner } from "./studio-runner.ts";

const { getLastCreatedServer, MockWebSocket, MockWebSocketServer } = await vi.hoisted(
	async () => import("../test/mocks/mock-ws"),
);

vi.mock(import("ws"), async () => {
	return {
		WebSocketServer: MockWebSocketServer,
	} as never;
});

const executeRequest = type({ action: "string", request_id: "string", script: "string" });

function connectAndReply(wss: MockWebSocketServerType, outputs: Array<string>): MockWebSocketType {
	const socket = new MockWebSocket();

	socket.send.mockImplementation((data) => {
		const message = executeRequest.assert(JSON.parse(data));
		queueMicrotask(() => {
			socket.emit(
				"message",
				Buffer.from(
					JSON.stringify({
						outputs,
						request_id: message.request_id,
						type: "results",
					}),
				),
			);
		});
	});

	wss.emit("connection", socket);
	return socket;
}

describe(StudioRunner, () => {
	it("should send script and return outputs", async () => {
		expect.assertions(2);

		const runner = new StudioRunner({ port: 0 });
		const promise = runner.executeScript({
			script: "return 'hello'",
			timeout: 30_000,
		});

		const wss = getLastCreatedServer()!;
		connectAndReply(wss, ["hello", "world"]);

		const result = await promise;

		expect(result.outputs).toStrictEqual(["hello", "world"]);
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("should throw on connection timeout", async () => {
		expect.assertions(1);

		const runner = new StudioRunner({ port: 0, timeout: 100 });

		await expect(runner.executeScript({ script: "return 1", timeout: 30_000 })).rejects.toThrow(
			"Timed out waiting for Studio plugin connection",
		);
	});

	it("should throw on plugin disconnect", async () => {
		expect.assertions(1);

		const runner = new StudioRunner({ port: 0 });
		const promise = runner.executeScript({
			script: "return 1",
			timeout: 30_000,
		});

		const wss = getLastCreatedServer()!;
		const socket = new MockWebSocket();
		wss.emit("connection", socket);

		queueMicrotask(() => {
			socket.emit("close");
		});

		await expect(promise).rejects.toThrow("Studio plugin disconnected before sending results");
	});

	it("should reject when plugin sends malformed message", async () => {
		expect.assertions(1);

		const runner = new StudioRunner({ port: 0 });
		const promise = runner.executeScript({
			script: "return 1",
			timeout: 30_000,
		});

		const wss = getLastCreatedServer()!;
		const socket = new MockWebSocket();

		socket.send.mockImplementation(() => {
			queueMicrotask(() => {
				socket.emit("message", Buffer.from(JSON.stringify({ type: "wrong" })));
			});
		});

		wss.emit("connection", socket);

		await expect(promise).rejects.toThrow(/Invalid plugin message/);
	});

	it("should reject when websocket emits error", async () => {
		expect.assertions(1);

		const runner = new StudioRunner({ port: 0 });
		const promise = runner.executeScript({
			script: "return 1",
			timeout: 30_000,
		});

		const wss = getLastCreatedServer()!;
		const socket = new MockWebSocket();
		wss.emit("connection", socket);

		queueMicrotask(() => {
			socket.emit("error", new Error("socket error"));
		});

		await expect(promise).rejects.toThrow("socket error");
	});

	it("should reject when server emits error", async () => {
		expect.assertions(1);

		const runner = new StudioRunner({ port: 0 });
		const promise = runner.executeScript({
			script: "return 1",
			timeout: 30_000,
		});

		const wss = getLastCreatedServer()!;

		queueMicrotask(() => {
			wss.emit("error", new Error("server error"));
		});

		await expect(promise).rejects.toThrow("server error");
	});

	it("should ignore messages with mismatched request ID", async () => {
		expect.assertions(1);

		const runner = new StudioRunner({ port: 0 });
		const promise = runner.executeScript({
			script: "return 1",
			timeout: 30_000,
		});

		const wss = getLastCreatedServer()!;
		const socket = new MockWebSocket();

		socket.send.mockImplementation((data) => {
			const message = executeRequest.assert(JSON.parse(data));
			queueMicrotask(() => {
				// First: wrong request_id
				socket.emit(
					"message",
					Buffer.from(
						JSON.stringify({
							outputs: ["wrong"],
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
							outputs: ["correct"],
							request_id: message.request_id,
							type: "results",
						}),
					),
				);
			});
		});

		wss.emit("connection", socket);

		const result = await promise;

		expect(result.outputs).toStrictEqual(["correct"]);
	});

	it("should close server after execution", async () => {
		expect.assertions(1);

		const runner = new StudioRunner({ port: 0 });
		const promise = runner.executeScript({
			script: "return 1",
			timeout: 30_000,
		});

		const wss = getLastCreatedServer()!;
		connectAndReply(wss, ["ok"]);

		await promise;

		expect(wss.close).toHaveBeenCalledWith();
	});

	it("should close server even on error", async () => {
		expect.assertions(2);

		const runner = new StudioRunner({ port: 0, timeout: 50 });

		await expect(runner.executeScript({ script: "return 1", timeout: 30_000 })).rejects.toThrow(
			"Timed out waiting for Studio plugin connection",
		);

		const wss = getLastCreatedServer()!;

		expect(wss.close).toHaveBeenCalledWith();
	});

	it("should return no-op for uploadPlace", async () => {
		expect.assertions(3);

		const runner = new StudioRunner({ port: 0 });
		const result = await runner.uploadPlace({ placeFilePath: "./test.rbxl" });

		expect(result.cached).toBe(false);
		expect(result.uploadMs).toBe(0);
		expect(result.versionNumber).toBe(0);
	});
});
