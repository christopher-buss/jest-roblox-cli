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
// send-mock to assert the backend keeps sending the handshake fields.
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

// Workspace jobs carry `pkg`; the backend then drives the staged materializer
// dispatch by sending `workspace.entries` rather than `config.configs`.
function wsJob(package_: string, displayName: string): ProjectJob {
	return { ...job(displayName), pkg: package_ };
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
							protocolVersion: 3,
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
							protocolVersion: 3,
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

	it("should reject a v2 plugin echo now that the protocol is v3", async () => {
		// The workspace dispatch + run-mode handshake bumped the contract to v3.
		// A plugin that still echoes v2 predates this CLI and must be rejected so
		// the user upgrades rather than running with stale runtime semantics.
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
							gameOutput: "[]",
							jestOutput: envelope([{ jestOutput: successResult() }]),
							protocolVersion: 2,
							request_id,
							type: "results",
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
							protocolVersion: 3,
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

	it("should send a workspace entries payload when jobs carry pkg", async () => {
		// The same run-mode dispatch lights up workspace in the attached
		// (WebSocket) studio backend. A workspace run sends `workspace.entries`,
		// not `config.configs` — the plugin's run-mode runner dispatches on
		// shape.
		expect.assertions(3);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTests({
			jobs: [wsJob("@scope/a", "a"), wsJob("@scope/b", "b")],
		});

		const workspaceRequest = type({
			request_id: "string",
			workspace: { entries: type({ pkg: "string", project: "string" }).array() },
		});

		const wss = getLastCreatedServer()!;
		const socket = new MockWebSocket();
		let captured: typeof workspaceRequest.infer | undefined;

		socket.send.mockImplementation((data) => {
			captured = workspaceRequest.assert(JSON.parse(data));
			const { request_id } = captured;
			queueMicrotask(() => {
				socket.emit(
					"message",
					Buffer.from(
						JSON.stringify({
							gameOutput: "[]",
							jestOutput: envelope([
								{ jestOutput: successResult() },
								{ jestOutput: successResult() },
							]),
							protocolVersion: 3,
							request_id,
							type: "results",
						}),
					),
				);
			});
		});

		wss.emit("connection", socket);
		await promise;

		expect(captured?.workspace.entries).toHaveLength(2);
		expect(captured?.workspace.entries[0]!.pkg).toBe("@scope/a");
		expect(captured?.workspace.entries[1]!.project).toBe("b");
	});

	it("should fail fast when a workspace run has a job missing its package name", async () => {
		// Workspace jobs are built all-or-none; a job without `pkg` alongside one
		// that has it means a malformed (mixed) array reached the backend. The
		// materializer keys entries by `pkg`, so reject rather than send a
		// `pkg`-less entry that would fail opaquely inside Studio.
		expect.assertions(1);

		const backend = new StudioBackend({ port: 0 });

		await expect(
			backend.runTests({ jobs: [wsJob("@scope/a", "a"), job("b")] }),
		).rejects.toThrow(/missing its package name/);
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

	it("should surface a top-level whole-run error as a clean message, not the raw payload", async () => {
		// A bare {success:false, err} is a wholesale failure (no per-job entry).
		// Surface the err itself rather than the JSON blob or the count guard.
		expect.assertions(1);

		const rawJestOutput = JSON.stringify({
			err: "Failed to find Jest instance",
			success: false,
		});

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTests(singleJobOptions);

		const wss = getLastCreatedServer()!;
		connectAndReply(wss, { rawJestOutput });

		await expect(promise).rejects.toThrow(/^Failed to find Jest instance$/);
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
							protocolVersion: 3,
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
							protocolVersion: 3,
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
							protocolVersion: 3,
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

	it("should surface a top-level whole-run error instead of the count-mismatch guard", async () => {
		// Regression: a wholesale failure (e.g. LoadString disabled) returns a
		// bare {success:false, err} for the whole request, not one entry per job.
		// The entries-vs-jobs guard used to mask the real cause behind
		// "returned 1 entries but request had N jobs". The error must win.
		expect.assertions(2);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTests({ jobs: [job("alpha"), job("beta")] });

		const wss = getLastCreatedServer()!;
		connectAndReply(wss, {
			rawJestOutput: JSON.stringify({
				err: "LoadString must be enabled in ServerScriptService to run tests",
				success: false,
			}),
		});

		await expect(promise).rejects.toThrow(
			/LoadString must be enabled in ServerScriptService to run tests/,
		);
		await expect(promise).rejects.not.toThrow(/entries but request had/);
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

	it("should terminate the connected plugin socket on close so the CLI can exit", async () => {
		// Regression: close() only closed the server, leaving the plugin socket
		// open. That open handle kept the Node event loop alive and hung the
		// CLI's process.exitCode-based shutdown whenever a Studio was detected.
		expect.assertions(1);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTests(singleJobOptions);
		const wss = getLastCreatedServer()!;
		const socket = connectAndReply(wss, {});
		await promise;

		backend.close();

		expect(socket.terminate).toHaveBeenCalledOnce();
	});

	it("should tear down a pre-connected server on close when runTests never ran", () => {
		// The auto probe can detect a Studio (preConnected) and then hit a
		// zero-jobs / passWithNoTests flow that closes the backend without ever
		// calling runTests — so `this.wss` is never assigned. close() must still
		// terminate the probe's socket and server, or the live handle hangs the
		// CLI.
		expect.assertions(2);

		const wss = new MockWebSocketServer({ port: 0 });
		const socket = new MockWebSocket();
		// Mirror ws: the probe's connection is tracked in server.clients.
		wss.emit("connection", socket);

		const backend = new StudioBackend({
			port: 0,
			preConnected: fromPartial({ server: wss, socket }),
		});

		backend.close();

		expect(socket.terminate).toHaveBeenCalledOnce();
		expect(wss.close).toHaveBeenCalledOnce();
	});
});
