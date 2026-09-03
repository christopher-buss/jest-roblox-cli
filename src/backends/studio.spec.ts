import { fromExact, fromPartial } from "@total-typescript/shoehorn";

import { type } from "arktype";
import { Buffer } from "node:buffer";
import { assert, describe, expect, it, onTestFinished, vi } from "vitest";

import type { MockWebSocketServer as MockWebSocketServerType } from "../../test/mocks/mock-web-socket-server.ts";
import type { MockWebSocket as MockWebSocketType } from "../../test/mocks/mock-web-socket.ts";
import { DEFAULT_CONFIG } from "../config/schema.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import type { JestResult } from "../types/jest-result.ts";
import type { BackendOptions, ProjectJob } from "./interface.ts";
import { StudioBackend } from "./studio.ts";

// The backend's own default run timeout, which is what a run that does not
// override it must tell the plugin to finish inside.
const DEFAULT_STUDIO_TIMEOUT = 300_000;

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
	requestId: "string",
});

// The protocol this CLI speaks, pinned here on purpose: the spec asserts the
// wire, so a bump has to be made deliberately in both places.
const PROTOCOL_VERSION = 7;

/**
 * Connect a plugin that announces a protocol the CLI can use.
 *
 * Dispatch waits for that announcement now, so a socket that only connects is
 * never asked to run anything.
 */
function connectPlugin(
	wss: MockWebSocketServerType,
	socket: MockWebSocketType = new MockWebSocket(),
	hello: Record<string, unknown> = {},
): MockWebSocketType {
	wss.emit("connection", socket);
	socket.emit(
		"message",
		Buffer.from(
			JSON.stringify({
				pluginName: "JestRobloxRunner",
				pluginVersion: "9.9.9",
				protocolVersion: PROTOCOL_VERSION,
				type: "hello",
				...hello,
			}),
		),
	);
	return socket;
}

/**
 * Fake the timers the plugin selection runs on, for a test that means to reach
 * the end of a window rather than wait one out.
 */
function useSelectionTimers(): void {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	onTestFinished(() => {
		vi.useRealTimers();
	});
}

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
function wsJob(packageName: string, displayName: string): ProjectJob {
	return { ...job(displayName), pkg: packageName };
}

const singleJobOptions: BackendOptions = { jobs: [job("")] };

interface ReplyOptions {
	entries?: Array<{ elapsedMs?: number; gameOutput?: string; jestOutput: string }>;
	gameOutput?: string;
	rawJestOutput?: string;
}

function successResult(overrides: Partial<JestResult> = {}): string {
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

const vmRequestSchema = type({
	"requestId": "string",
	"runBudgetMs?": "number",
	"vmParallel?": "number",
});

/**
 * Run `jobCount` jobs through the backend with the given VM request and hand
 * back the payload the plugin saw.
 */
async function captureVmRequestAsync(
	jobCount: number,
	vmParallel: "auto" | number | undefined,
): Promise<typeof vmRequestSchema.infer> {
	const backend = new StudioBackend({ port: 0 });
	const jobs = Array.from({ length: jobCount }, (_unused, index) => job(`job-${String(index)}`));
	const promise = backend.runTestsAsync({ jobs, vmParallel });

	const wss = getLastCreatedServer()!;
	const socket = new MockWebSocket();
	let captured: typeof vmRequestSchema.infer | undefined;

	socket.send.mockImplementation((data) => {
		captured = vmRequestSchema.assert(JSON.parse(data));
		queueMicrotask(() => {
			socket.emit(
				"message",
				Buffer.from(
					JSON.stringify({
						gameOutput: "[]",
						jestOutput: envelope(jobs.map(() => ({ jestOutput: successResult() }))),
						protocolVersion: PROTOCOL_VERSION,
						requestId: captured!.requestId,
						type: "results",
					}),
				),
			);
		});
	});

	connectPlugin(wss, socket);
	await promise;

	return captured!;
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
							protocolVersion: PROTOCOL_VERSION,
							requestId: message.requestId,
							type: "results",
						}),
					),
				);
			});
		}
	});

	connectPlugin(wss, socket);
	return socket;
}

describe("protocol version handshake", () => {
	it("should include protocolVersion in the run_tests payload", async () => {
		expect.assertions(1);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTestsAsync(singleJobOptions);

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
							protocolVersion: PROTOCOL_VERSION,
							requestId: captured!.requestId,
							type: "results",
						}),
					),
				);
			});
		});

		connectPlugin(wss, socket);
		await promise;

		expect(captured!.protocolVersion).toBeTypeOf("number");
	});

	it("should reject a response that omits the protocolVersion echo", async () => {
		expect.assertions(1);

		// A plugin that announces a protocol it does not actually serve:
		// selected on its announcement, then answering like a pre-v2 plugin
		// that ignored the request-side `protocolVersion`. Schema rejection on
		// the response surfaces this as the standard "Invalid plugin message"
		// error rather than running with no runtime injection.
		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTestsAsync(singleJobOptions);

		const wss = getLastCreatedServer()!;
		const socket = new MockWebSocket();

		socket.send.mockImplementation((data) => {
			const { requestId } = pluginRequest.assert(JSON.parse(data));
			queueMicrotask(() => {
				socket.emit(
					"message",
					Buffer.from(
						JSON.stringify({
							gameOutput: "[]",
							jestOutput: envelope([{ jestOutput: successResult() }]),
							requestId,
							type: "results",
							// no protocolVersion — simulating stale plugin
						}),
					),
				);
			});
		});

		connectPlugin(wss, socket);

		await expect(promise).rejects.toThrow(/invalid plugin message/i);
	});

	it("should reject an echo from a protocol older than the current one", async () => {
		// A plugin that echoes an older protocol than it announced predates this
		// CLI and must be rejected so the user upgrades rather than running with
		// stale runtime semantics.
		expect.assertions(1);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTestsAsync(singleJobOptions);

		const wss = getLastCreatedServer()!;
		const socket = new MockWebSocket();

		socket.send.mockImplementation((data) => {
			const { requestId } = pluginRequest.assert(JSON.parse(data));
			queueMicrotask(() => {
				socket.emit(
					"message",
					Buffer.from(
						JSON.stringify({
							gameOutput: "[]",
							jestOutput: envelope([{ jestOutput: successResult() }]),
							protocolVersion: 2,
							requestId,
							type: "results",
						}),
					),
				);
			});
		});

		connectPlugin(wss, socket);

		await expect(promise).rejects.toThrow(/invalid plugin message/i);
	});

	it("should dispatch only to the plugin whose announced protocol matches", async () => {
		// The multi-install case: Studio runs every copy in the plugins folder
		// and each opens its own socket. A stale copy refuses the moment it is
		// asked, while the copy that can serve the run is still running the
		// suite — so asking all of them means the refusal decides the run.
		expect.assertions(3);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTestsAsync(singleJobOptions);

		const wss = getLastCreatedServer()!;
		const stale = connectPlugin(wss, new MockWebSocket(), {
			pluginVersion: "0.3.18",
			protocolVersion: PROTOCOL_VERSION - 1,
		});
		const ancient = connectPlugin(wss, new MockWebSocket(), {
			protocolVersion: PROTOCOL_VERSION - 3,
		});
		const current = connectAndReply(wss, {});

		await promise;

		expect(current.send).toHaveBeenCalledOnce();
		expect(stale.send).not.toHaveBeenCalled();
		expect(ancient.send).not.toHaveBeenCalled();
	});

	it("should name every connected plugin when none of them match", async () => {
		expect.assertions(4);

		// Fake timers: the grace window the CLI holds open for announcements is
		// the only thing this waits on, and it is a real 750ms otherwise.
		useSelectionTimers();
		const backend = new StudioBackend({ port: 0 });
		const settled = backend.runTestsAsync(singleJobOptions).catch((err: unknown) => err);

		const wss = getLastCreatedServer()!;
		connectPlugin(wss, new MockWebSocket(), {
			pluginVersion: "0.3.18",
			protocolVersion: PROTOCOL_VERSION - 1,
		});
		connectPlugin(wss, new MockWebSocket(), {
			pluginName: "OldRunner",
			pluginVersion: undefined,
			protocolVersion: PROTOCOL_VERSION - 2,
		});
		await vi.runAllTimersAsync();

		const caught: unknown = await settled;
		assert(caught instanceof Error);

		expect(caught.message).toContain("No compatible jest-roblox Studio plugin");
		expect(caught.message).toContain(
			`JestRobloxRunner 0.3.18 (protocol v${PROTOCOL_VERSION - 1})`,
		);
		expect(caught.message).toContain(
			`OldRunner (protocol v${PROTOCOL_VERSION - 2}, version not reported)`,
		);
		expect(caught.message).toContain("remove the other copies");
	});

	it("should report a connection that never announces itself", async () => {
		// Every plugin predating the handshake looks like this: connected,
		// silent, and unusable. It has to be named rather than waited on.
		expect.assertions(1);

		useSelectionTimers();
		const backend = new StudioBackend({ port: 0 });
		const settled = backend.runTestsAsync(singleJobOptions).catch((err: unknown) => err);

		const wss = getLastCreatedServer()!;
		wss.emit("connection", new MockWebSocket());
		await vi.runAllTimersAsync();

		const caught: unknown = await settled;
		assert(caught instanceof Error);

		expect(caught.message).toContain("sent no handshake");
	});

	it("should throw a clear upgrade error on version_mismatch response", async () => {
		expect.assertions(1);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTestsAsync(singleJobOptions);

		const wss = getLastCreatedServer()!;
		const socket = new MockWebSocket();

		socket.send.mockImplementation((data) => {
			const { requestId } = pluginRequest.assert(JSON.parse(data));
			queueMicrotask(() => {
				socket.emit(
					"message",
					Buffer.from(
						JSON.stringify({
							actualVersion: 1,
							expectedVersion: 2,
							requestId,
							type: "version_mismatch",
						}),
					),
				);
			});
		});

		connectPlugin(wss, socket);

		await expect(promise).rejects.toThrow(/protocol version mismatch/i);
	});
});

describe(StudioBackend, () => {
	it("should send one envelope carrying a configs array with one entry per job", async () => {
		expect.assertions(4);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTestsAsync({
			jobs: [
				job("alpha", { testNamePattern: "alpha-pattern" }),
				job("beta", { testNamePattern: "beta-pattern" }),
			],
		});

		// Narrower than the shared `pluginRequest` (whose `configs` is
		// `unknown[]`): this test reads back each job's `testNamePattern`.
		const configsRequest = type({
			config: { configs: type({ "testNamePattern?": "string" }).array() },
			requestId: "string",
		});

		const wss = getLastCreatedServer()!;
		const socket = new MockWebSocket();
		let capturedConfig: typeof configsRequest.infer.config | undefined;

		socket.send.mockImplementation((data) => {
			const message = configsRequest.assert(JSON.parse(data));
			capturedConfig = message.config;
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
							protocolVersion: PROTOCOL_VERSION,
							requestId: message.requestId,
							type: "results",
						}),
					),
				);
			});
		});

		connectPlugin(wss, socket);

		await promise;

		expect(socket.send).toHaveBeenCalledOnce();
		expect(capturedConfig!.configs).toHaveLength(2);
		expect(capturedConfig!.configs[0]!.testNamePattern).toBe("alpha-pattern");
		expect(capturedConfig!.configs[1]!.testNamePattern).toBe("beta-pattern");
	});

	describe("experimental vm-parallel", () => {
		// The VM count the plugin receives is a request the CLI has already
		// resolved: `"auto"` becomes one VM per config (up to the hosts the
		// plugin ships), an oversized count is clamped to the configs there
		// are, and anything that lands on a single VM leaves the field off —
		// that is the sequential path.
		it("should send the run budget the coordinator must finish inside", async () => {
			expect.assertions(1);

			const captured = await captureVmRequestAsync(2, 2);

			expect(captured.runBudgetMs).toBe(DEFAULT_STUDIO_TIMEOUT);
		});

		it("should leave the run budget off a sequential run", async () => {
			expect.assertions(1);

			const captured = await captureVmRequestAsync(2, undefined);

			expect(captured.runBudgetMs).toBeUndefined();
		});

		it.for([
			{ expected: 2, jobCount: 2, requested: 2 },
			{ expected: 3, jobCount: 3, requested: "auto" as const },
			{ expected: 2, jobCount: 2, requested: 5 },
			{ expected: undefined, jobCount: 2, requested: 1 },
			{ expected: undefined, jobCount: 2, requested: undefined },
			{ expected: 4, jobCount: 6, requested: "auto" as const },
		])(
			"should send vmParallel $expected for $requested over $jobCount jobs",
			async ({ expected, jobCount, requested }) => {
				expect.assertions(1);

				const captured = await captureVmRequestAsync(jobCount, requested);

				expect(captured.vmParallel).toBe(expected);
			},
		);
	});

	it("should send a workspace entries payload when jobs carry pkg", async () => {
		// The same run-mode dispatch lights up workspace in the attached
		// (WebSocket) studio backend. A workspace run sends `workspace.entries`,
		// not `config.configs` — the plugin's run-mode runner dispatches on
		// shape.
		expect.assertions(3);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTestsAsync({
			jobs: [wsJob("@scope/a", "a"), wsJob("@scope/b", "b")],
		});

		const workspaceRequest = type({
			requestId: "string",
			workspace: { entries: type({ pkg: "string", project: "string" }).array() },
		});

		const wss = getLastCreatedServer()!;
		const socket = new MockWebSocket();
		let captured: typeof workspaceRequest.infer | undefined;

		socket.send.mockImplementation((data) => {
			captured = workspaceRequest.assert(JSON.parse(data));
			const { requestId } = captured;
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
							protocolVersion: PROTOCOL_VERSION,
							requestId,
							type: "results",
						}),
					),
				);
			});
		});

		connectPlugin(wss, socket);
		await promise;

		expect(captured!.workspace.entries).toHaveLength(2);
		expect(captured!.workspace.entries[0]!.pkg).toBe("@scope/a");
		expect(captured!.workspace.entries[1]!.project).toBe("b");
	});

	it("should fail fast when a workspace run has a job missing its package name", async () => {
		// Workspace jobs are built all-or-none; a job without `pkg` alongside one
		// that has it means a malformed (mixed) array reached the backend. The
		// materializer keys entries by `pkg`, so reject rather than send a
		// `pkg`-less entry that would fail opaquely inside Studio.
		expect.assertions(1);

		const backend = new StudioBackend({ port: 0 });

		await expect(
			backend.runTestsAsync({ jobs: [wsJob("@scope/a", "a"), job("b")] }),
		).rejects.toThrow(/missing its package name/);
	});

	it("should return rawResults in the same order as the submitted jobs", async () => {
		expect.assertions(2);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTestsAsync({ jobs: [job("alpha"), job("beta"), job("gamma")] });

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
		const promise = backend.runTestsAsync(singleJobOptions);

		const wss = getLastCreatedServer()!;
		connectAndReply(wss, {});

		const result = await promise;

		expect(result.timing.executionMs).toBeGreaterThanOrEqual(0);
	});

	it("should surface the fallback gameOutput on each rawResult", async () => {
		expect.assertions(1);

		const fallback = JSON.stringify([{ message: "fallback", messageType: 0, timestamp: 0 }]);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTestsAsync(singleJobOptions);

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
		const promise = backend.runTestsAsync(singleJobOptions);

		const wss = getLastCreatedServer()!;
		connectAndReply(wss, { rawJestOutput });

		await expect(promise).rejects.toThrow(/^Failed to find Jest instance$/);
	});

	it("should rethrow syntax errors when jestOutput is not valid JSON", async () => {
		expect.assertions(1);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTestsAsync(singleJobOptions);

		const wss = getLastCreatedServer()!;
		connectAndReply(wss, { rawJestOutput: "{bad json" });

		await expect(promise).rejects.toThrow(SyntaxError);
	});

	it("should throw on connection timeout", async () => {
		expect.assertions(1);

		useSelectionTimers();
		const backend = new StudioBackend({ port: 0, timeout: 100 });

		const settled = backend.runTestsAsync(singleJobOptions).catch((err: unknown) => err);
		await vi.runAllTimersAsync();
		const caught: unknown = await settled;

		assert(caught instanceof Error);

		expect(caught.message).toContain("Timed out waiting for Studio plugin connection");
	});

	it("should throw when the selected plugin never returns results", async () => {
		// Distinct from the connection timeout: a plugin was found and asked,
		// and then went quiet. Saying "waiting for a connection" here would
		// send the user looking for the wrong fault.
		expect.assertions(1);

		useSelectionTimers();
		const backend = new StudioBackend({ port: 0, timeout: 100 });
		const settled = backend.runTestsAsync(singleJobOptions).catch((err: unknown) => err);

		connectPlugin(getLastCreatedServer()!);
		await vi.runAllTimersAsync();
		const caught: unknown = await settled;

		assert(caught instanceof Error);

		expect(caught.message).toBe("Timed out waiting for the Studio plugin to return results");
	});

	it("should throw when the plugin disconnects before sending results", async () => {
		expect.assertions(1);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTestsAsync(singleJobOptions);

		const wss = getLastCreatedServer()!;
		const socket = new MockWebSocket();
		socket.send.mockImplementation(() => {
			queueMicrotask(() => {
				socket.emit("close");
			});
		});
		connectPlugin(wss, socket);

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
							protocolVersion: PROTOCOL_VERSION,
							requestId: message.requestId,
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

		const { rawResults } = await backend.runTestsAsync(singleJobOptions);

		expect(rawResults).toHaveLength(1);
		expect(rawResults[0]!.entry.jestOutput).toContain('"numPassedTests":3');
	});

	it("should reject when the plugin sends a malformed message", async () => {
		expect.assertions(1);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTestsAsync(singleJobOptions);

		const wss = getLastCreatedServer()!;
		const socket = new MockWebSocket();

		socket.send.mockImplementation(() => {
			queueMicrotask(() => {
				socket.emit("message", Buffer.from(JSON.stringify({ type: "wrong" })));
			});
		});

		connectPlugin(wss, socket);

		await expect(promise).rejects.toThrowWithMessage(Error, /Invalid plugin message/);
	});

	it("should reject when the websocket emits an error", async () => {
		expect.assertions(1);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTestsAsync(singleJobOptions);

		const wss = getLastCreatedServer()!;
		const socket = new MockWebSocket();
		socket.send.mockImplementation(() => {
			queueMicrotask(() => {
				socket.emit("error", new Error("socket error"));
			});
		});
		connectPlugin(wss, socket);

		await expect(promise).rejects.toThrowWithMessage(Error, "socket error");
	});

	it("should reject when the server emits an error", async () => {
		expect.assertions(1);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTestsAsync(singleJobOptions);

		const wss = getLastCreatedServer()!;

		queueMicrotask(() => {
			wss.emit("error", new Error("server error"));
		});

		await expect(promise).rejects.toThrowWithMessage(Error, "server error");
	});

	it("should ignore messages whose requestId does not match", async () => {
		expect.assertions(1);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTestsAsync(singleJobOptions);

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
							protocolVersion: PROTOCOL_VERSION,
							requestId: "wrong-id",
							type: "results",
						}),
					),
				);
				socket.emit(
					"message",
					Buffer.from(
						JSON.stringify({
							jestOutput: envelope([{ jestOutput: successResult() }]),
							protocolVersion: PROTOCOL_VERSION,
							requestId: message.requestId,
							type: "results",
						}),
					),
				);
			});
		});

		connectPlugin(wss, socket);

		const { rawResults } = await promise;

		expect(rawResults).toHaveLength(1);
	});

	it("should reuse the same WebSocketServer across successive runTests calls", async () => {
		expect.assertions(2);

		const backend = new StudioBackend({ port: 0 });

		const firstPromise = backend.runTestsAsync(singleJobOptions);
		const firstWss = getLastCreatedServer()!;
		connectAndReply(firstWss, {});
		await firstPromise;

		const secondPromise = backend.runTestsAsync(singleJobOptions);
		const secondWss = getLastCreatedServer()!;
		connectAndReply(secondWss, {});
		await secondPromise;

		expect(secondWss).toBe(firstWss);
		expect(firstWss.close).not.toHaveBeenCalled();
	});

	it("should throw when the runtime returns more entries than jobs", async () => {
		expect.assertions(1);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTestsAsync(singleJobOptions);

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
		const promise = backend.runTestsAsync({ jobs: [job("alpha"), job("beta")] });

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
		const promise = backend.runTestsAsync({ jobs: [job("alpha"), job("beta")] });

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
		const promise = backend.runTestsAsync(singleJobOptions);
		const wss = getLastCreatedServer()!;
		connectAndReply(wss, {});
		await promise;

		backend.closeAsync();

		expect(wss.close).toHaveBeenCalledOnce();

		// A second close() should no-op rather than double-closing.
		backend.closeAsync();

		expect(wss.close).toHaveBeenCalledOnce();
	});

	it("should terminate the connected plugin socket on close so the CLI can exit", async () => {
		// Regression: close() only closed the server, leaving the plugin socket
		// open. That open handle kept the Node event loop alive and hung the
		// CLI's process.exitCode-based shutdown whenever a Studio was detected.
		expect.assertions(1);

		const backend = new StudioBackend({ port: 0 });
		const promise = backend.runTestsAsync(singleJobOptions);
		const wss = getLastCreatedServer()!;
		const socket = connectAndReply(wss, {});
		await promise;

		backend.closeAsync();

		expect(socket.terminate).toHaveBeenCalledOnce();
	});

	it("should stop the pending selection on close so the CLI can exit", async () => {
		// Closing the server does not stop the pool's connect timer. On the
		// default timeout that handle holds the process open for five minutes
		// after a failure the caller has already surfaced.
		expect.assertions(1);

		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		onTestFinished(() => {
			vi.useRealTimers();
		});

		const backend = new StudioBackend({ port: 0 });
		const settled = backend.runTestsAsync(singleJobOptions).catch((err: unknown) => err);
		backend.closeAsync();

		const caught: unknown = await settled;
		assert(caught instanceof Error);

		expect(vi.getTimerCount()).toBe(0);
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
		connectPlugin(wss, socket);

		const backend = new StudioBackend({
			port: 0,
			preConnected: fromPartial({ server: wss, socket }),
		});

		backend.closeAsync();

		expect(socket.terminate).toHaveBeenCalledOnce();
		expect(wss.close).toHaveBeenCalledOnce();
	});
});
