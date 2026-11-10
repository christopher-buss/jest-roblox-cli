import { fromPartial } from "@total-typescript/shoehorn";

import { type } from "arktype";
import { Buffer } from "node:buffer";
import { assert, describe, expect, it, onTestFinished, vi } from "vitest";

import type { MockWebSocketServer } from "#test/mocks/mock-web-socket-server.ts";
import {
	getLastCreatedServer,
	mockWebSocketServerFactory as webSocketServerFactory,
} from "#test/mocks/mock-web-socket-server.ts";
import { MockWebSocket } from "#test/mocks/mock-web-socket.ts";
import { projectJob } from "#test/mocks/project-job.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import {
	type ConfiguredJobs,
	envelope,
	studioRequest,
	successResult,
	timed,
} from "#test/mocks/studio-request.ts";
import type { ResolvedConfig } from "../config/resolved-config.ts";
import type { ConfiguredJob } from "../executor/executor-types.ts";
import type { RunProgress } from "../progress/run-progress.ts";
import {
	DEFAULT_STUDIO_PORT,
	STUDIO_PORT_ATTRIBUTE,
	STUDIO_PROTOCOL_VERSION,
} from "../protocol/studio.ts";
import { StudioBackend } from "./studio.ts";

const RUN_TIMEOUT = 300_000;

// Mirrors the wire format StudioBackend emits in `attachSocket` — used by the
// send-mock to assert the backend keeps sending the handshake fields.
// Drift here means the protocol-version handshake regressed.
const pluginRequest = type({
	action: "string",
	configs: "unknown[]",
	protocolVersion: "number",
	requestId: "string",
});

/**
 * Connect a plugin that announces a protocol the CLI can use.
 *
 * Dispatch waits for that announcement now, so a socket that only connects is
 * never asked to run anything.
 * @param root0 - Connection input.
 * @param root0.hello - Fields that override the default announcement.
 * @param root0.socket - Socket to connect.
 * @param root0.wss - Server the socket connects to.
 * @returns The connected socket.
 */
function connectPlugin({
	hello = {},
	socket = new MockWebSocket(),
	wss,
}: {
	readonly hello?: Record<string, unknown>;
	readonly socket?: MockWebSocket;
	readonly wss: MockWebSocketServer;
}): MockWebSocket {
	wss.emit("connection", socket);
	socket.emit(
		"message",
		Buffer.from(
			JSON.stringify({
				pluginName: "JestRobloxRunner",
				pluginVersion: "9.9.9",
				protocolVersion: STUDIO_PROTOCOL_VERSION,
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

function job(displayName: string, overrides: Partial<ResolvedConfig> = {}): ConfiguredJob {
	return projectJob({
		config: {
			...createResolvedConfig(),
			backend: "studio",
			placeFile: "./test.rbxl",
			...overrides,
		},
		displayColor: `${displayName}-color`,
		displayName,
		testFiles: [`${displayName}/test.spec.ts`],
	});
}

/**
 * Workspace jobs carry `pkg`; the backend then drives the staged materializer
 * dispatch by sending `workspace.entries` rather than `configs`.
 * @param packageName - Workspace package of the job.
 * @param displayName - Label for the job and its test file.
 * @returns The workspace job.
 */
function wsJob(packageName: string, displayName: string): ConfiguredJob {
	return { ...job(displayName), pkg: packageName };
}

const singleJobOptions = studioRequest({ jobs: [job("")] });

interface ReplyOptions {
	entries?: Array<{ elapsedMs?: number; gameOutput?: string; jestOutput: string }>;
	gameOutput?: string;
	rawJestOutput?: string;
}

const vmRequestSchema = type({
	"requestId": "string",
	"runBudgetMs?": "number",
	"vmParallel?": "number",
});

/**
 * Run `jobCount` jobs through the backend with the given VM request and hand
 * back the payload the plugin saw.
 * @param jobCount - Number of jobs to run.
 * @param vmParallel - VM parallelism to request.
 * @returns The VM fields of the request the plugin received.
 */
async function captureVmRequestAsync(
	jobCount: number,
	vmParallel: "auto" | number | undefined,
): Promise<typeof vmRequestSchema.infer> {
	const backend = new StudioBackend({
		port: 0,
		webSocketServerFactory,
	});
	const [first, ...rest] = Array.from({ length: jobCount }, (_unused, index) => {
		return job(`job-${String(index)}`);
	});
	const jobs: ConfiguredJobs["jobs"] = [first!, ...rest];
	const promise = backend.runTestsAsync(studioRequest({ jobs, vmParallel }));

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
						protocolVersion: STUDIO_PROTOCOL_VERSION,
						requestId: captured!.requestId,
						type: "results",
					}),
				),
			);
		});
	});

	connectPlugin({ socket, wss });
	await promise;

	return captured!;
}

// Any run request, config- or workspace-shaped: what a reply needs to echo.
const runRequestSchema = type({ action: "string", requestId: "string" });

async function startWithSocketAsync(onSend: (socket: MockWebSocket, data: string) => void) {
	const backend = new StudioBackend({
		port: 0,
		webSocketServerFactory,
	});
	const promise = backend.runTestsAsync(singleJobOptions);
	const socket = new MockWebSocket();
	socket.send.mockImplementation((data) => {
		queueMicrotask(() => {
			onSend(socket, data);
		});
	});
	connectPlugin({ socket, wss: getLastCreatedServer()! });
	return promise;
}

async function startWithReplyAsync(build: (requestId: string) => Record<string, unknown>) {
	return startWithSocketAsync((socket, data) => {
		const { requestId } = pluginRequest.assert(JSON.parse(data));
		socket.emit("message", Buffer.from(JSON.stringify(build(requestId))));
	});
}

function connectAndReply(wss: MockWebSocketServer, reply: ReplyOptions): MockWebSocket {
	const socket = new MockWebSocket();

	socket.send.mockImplementation((data) => {
		const message = runRequestSchema.assert(JSON.parse(data));
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
							protocolVersion: STUDIO_PROTOCOL_VERSION,
							requestId: message.requestId,
							type: "results",
						}),
					),
				);
			});
		}
	});

	connectPlugin({ socket, wss });
	return socket;
}

describe("protocol version handshake", () => {
	it("should include protocolVersion in the run_tests payload", async () => {
		expect.assertions(1);

		const backend = new StudioBackend({
			port: 0,
			webSocketServerFactory,
		});
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
							protocolVersion: STUDIO_PROTOCOL_VERSION,
							requestId: captured!.requestId,
							type: "results",
						}),
					),
				);
			});
		});

		connectPlugin({ socket, wss });
		await promise;

		expect(captured!.protocolVersion).toBeTypeOf("number");
	});

	it("should reject a response that omits the protocolVersion echo", async () => {
		expect.assertions(2);

		useSelectionTimers();

		// A plugin that announces a protocol it does not actually serve:
		// selected on its announcement, then answering like a pre-v2 plugin
		// that ignored the request-side `protocolVersion`. Schema rejection on
		// the response surfaces this as the standard "Invalid plugin message"
		// error rather than running with no runtime injection.
		const promise = startWithReplyAsync((requestId) => {
			return {
				gameOutput: "[]",
				jestOutput: envelope([{ jestOutput: successResult() }]),
				requestId,
				type: "results",
				// no protocolVersion — simulating stale plugin
			};
		});

		await expect(promise).rejects.toThrow(/invalid plugin message/i);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("should name the Studio backend when the runner defers jobs", async () => {
		expect.assertions(1);

		const promise = startWithReplyAsync((requestId) => {
			return {
				gameOutput: "[]",
				jestOutput: envelope([], { deferred: true }),
				protocolVersion: STUDIO_PROTOCOL_VERSION,
				requestId,
				type: "results",
			};
		});

		await expect(promise).rejects.toThrow(
			"Studio backend deferred 1 of 1 jobs: the runner's result budget filled before they ran",
		);
	});

	it("should reject an echo from a protocol older than the current one", async () => {
		// A plugin that echoes an older protocol than it announced predates this
		// CLI and must be rejected so the user upgrades rather than running with
		// stale runtime semantics.
		expect.assertions(1);

		const promise = startWithReplyAsync((requestId) => {
			return {
				gameOutput: "[]",
				jestOutput: envelope([{ jestOutput: successResult() }]),
				protocolVersion: 2,
				requestId,
				type: "results",
			};
		});

		await expect(promise).rejects.toThrow(/invalid plugin message/i);
	});

	it("should name every connected plugin when none of them match", async () => {
		expect.assertions(4);

		// Fake timers: the grace window the CLI holds open for announcements is
		// the only thing this waits on, and it is a real 750ms otherwise.
		useSelectionTimers();
		const backend = new StudioBackend({
			port: 0,
			webSocketServerFactory,
		});
		const settled = backend.runTestsAsync(singleJobOptions).catch((err: unknown) => err);

		const wss = getLastCreatedServer()!;
		connectPlugin({
			hello: {
				pluginVersion: "0.3.18",
				protocolVersion: STUDIO_PROTOCOL_VERSION - 1,
			},
			socket: new MockWebSocket(),
			wss,
		});
		connectPlugin({
			hello: {
				pluginName: "OldRunner",
				pluginVersion: undefined,
				protocolVersion: STUDIO_PROTOCOL_VERSION - 2,
			},
			socket: new MockWebSocket(),
			wss,
		});
		await vi.runAllTimersAsync();

		const caught: unknown = await settled;
		assert(caught instanceof Error);

		expect(caught.message).toContain("No compatible jest-roblox Studio plugin");
		expect(caught.message).toContain(
			`JestRobloxRunner 0.3.18 (protocol v${STUDIO_PROTOCOL_VERSION - 1})`,
		);
		expect(caught.message).toContain(
			`OldRunner (protocol v${STUDIO_PROTOCOL_VERSION - 2}, version not reported)`,
		);
		expect(caught.message).toContain("remove the other copies");
	});

	it("should throw a clear upgrade error on version_mismatch response", async () => {
		expect.assertions(1);

		const promise = startWithReplyAsync((requestId) => {
			return {
				actualVersion: 1,
				expectedVersion: 2,
				requestId,
				type: "version_mismatch",
			};
		});

		await expect(promise).rejects.toThrowWithMessage(
			Error,
			"Studio plugin protocol version mismatch: plugin reported v1, CLI expected v2. " +
				"Update the jest-roblox Studio plugin to match this CLI version.",
		);
	});
});

describe(StudioBackend, () => {
	it("should send one envelope carrying a configs array with one entry per job", async () => {
		expect.assertions(3);

		const backend = new StudioBackend({
			port: 0,
			webSocketServerFactory,
		});
		const promise = backend.runTestsAsync(
			studioRequest({
				jobs: [
					{
						...job("alpha", { testNamePattern: "alpha-pattern" }),
						runtimeInjectionPaths: ["ReplicatedStorage/alpha"],
					},
					job("beta", { testNamePattern: "beta-pattern" }),
				],
			}),
		);

		// Narrower than the shared `pluginRequest` (whose `configs` is
		// `unknown[]`): this test reads back each job's `testNamePattern`.
		const configsRequest = type({
			configs: type({
				config: { "testNamePattern?": "string" },
				runtimeStubMounts: "string[]",
			}).array(),
			requestId: "string",
		});

		const wss = getLastCreatedServer()!;
		const socket = new MockWebSocket();
		let capturedConfig: typeof configsRequest.infer.configs | undefined;

		socket.send.mockImplementation((data) => {
			const message = configsRequest.assert(JSON.parse(data));
			capturedConfig = message.configs;
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
							protocolVersion: STUDIO_PROTOCOL_VERSION,
							requestId: message.requestId,
							type: "results",
						}),
					),
				);
			});
		});

		connectPlugin({ socket, wss });

		await promise;

		expect(socket.send).toHaveBeenCalledExactlyOnceWith(
			expect.stringContaining('"action":"run_tests"'),
		);
		expect(capturedConfig!.map(({ config }) => config.testNamePattern)).toStrictEqual([
			"alpha-pattern",
			"beta-pattern",
		]);
		expect(capturedConfig!.map(({ runtimeStubMounts }) => runtimeStubMounts)).toStrictEqual([
			["ReplicatedStorage/alpha"],
			[],
		]);
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

			expect(captured.runBudgetMs).toBe(RUN_TIMEOUT);
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
		// not `configs` — the plugin's run-mode runner dispatches on
		// shape.
		expect.assertions(4);

		const backend = new StudioBackend({
			port: 0,
			webSocketServerFactory,
		});
		const promise = backend.runTestsAsync(
			studioRequest({
				jobs: [wsJob("@scope/a", "a"), wsJob("@scope/b", "b")],
			}),
		);

		const workspaceRequest = type({
			requestId: "string",
			workspace: {
				entries: type({ pkg: "string", project: "string" }).array(),
				resultBudgetBytes: "number",
			},
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
							protocolVersion: STUDIO_PROTOCOL_VERSION,
							requestId,
							type: "results",
						}),
					),
				);
			});
		});

		connectPlugin({ socket, wss });
		await promise;

		expect(captured!.workspace.entries).toHaveLength(2);
		expect(captured!.workspace.entries[0]!.pkg).toBe("@scope/a");
		expect(captured!.workspace.entries[1]!.project).toBe("b");
		expect(captured!.workspace.resultBudgetBytes).toBe(Number.MAX_SAFE_INTEGER);
	});

	it("should tell the workspace runner to stop on the first failing package under --bail", async () => {
		expect.assertions(1);

		const backend = new StudioBackend({
			port: 0,
			webSocketServerFactory,
		});
		const promise = backend.runTestsAsync(
			studioRequest({ bail: true, jobs: [wsJob("@scope/a", "a")] }),
		);

		const socket = connectAndReply(getLastCreatedServer()!, {});
		await promise;

		const request = type({ workspace: { "bail?": "boolean" } }).assert(
			JSON.parse(socket.send.mock.calls[0]![0]),
		);

		expect(request.workspace.bail).toBeTrue();
	});

	it("should return rawResults in the same order as the submitted jobs", async () => {
		expect.assertions(2);

		const backend = new StudioBackend({
			port: 0,
			webSocketServerFactory,
		});
		const promise = backend.runTestsAsync(
			studioRequest({ jobs: [job("alpha"), job("beta"), job("gamma")] }),
		);

		const wss = getLastCreatedServer()!;
		connectAndReply(wss, {
			entries: [
				{ gameOutput: "11", jestOutput: successResult() },
				{ gameOutput: "22", jestOutput: successResult() },
				{ gameOutput: "33", jestOutput: successResult() },
			],
		});

		const { rawResults } = await promise;

		expect(rawResults).toHaveLength(3);
		expect(rawResults.map((raw) => raw.entry.gameOutput)).toStrictEqual(["11", "22", "33"]);
	});

	it("should populate timing.executionMs on the BackendResult", async () => {
		expect.assertions(1);

		const now = vi
			.spyOn(Date, "now")
			.mockReturnValueOnce(100)
			.mockReturnValueOnce(120)
			.mockReturnValueOnce(145);
		onTestFinished(() => {
			now.mockRestore();
		});

		const backend = new StudioBackend({
			port: 0,
			webSocketServerFactory,
		});
		const promise = backend.runTestsAsync(singleJobOptions);

		const wss = getLastCreatedServer()!;
		connectAndReply(wss, {});

		const result = await promise;

		expect(result.timing.executionMs).toBe(45);
	});

	it("should close the tests progress stage after results arrive", async () => {
		expect.assertions(3);

		useSelectionTimers();

		const done = vi.fn<() => void>();
		const begin = vi.fn<RunProgress["begin"]>(() => done);
		const backend = new StudioBackend({
			port: 0,
			webSocketServerFactory,
		});
		const promise = backend.runTestsAsync(
			studioRequest({
				...singleJobOptions,
				progress: fromPartial({ begin }),
			}),
		);
		connectAndReply(getLastCreatedServer()!, {});

		await promise;

		expect(begin).toHaveBeenCalledExactlyOnceWith("tests", "1 project");
		expect(done).toHaveBeenCalledExactlyOnceWith();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("should surface the fallback gameOutput on each rawResult", async () => {
		expect.assertions(1);

		const fallback = JSON.stringify([{ message: "fallback", messageType: 0, timestamp: 0 }]);

		const backend = new StudioBackend({
			port: 0,
			webSocketServerFactory,
		});
		const promise = backend.runTestsAsync(singleJobOptions);

		const wss = getLastCreatedServer()!;
		connectAndReply(wss, { gameOutput: fallback });

		const { rawResults } = await promise;

		expect(rawResults[0]!.fallbackGameOutput).toBe(fallback);
	});

	it("should throw on connection timeout", async () => {
		expect.assertions(1);

		useSelectionTimers();
		const backend = new StudioBackend({ port: 0, webSocketServerFactory });

		const settled = backend
			.runTestsAsync(timed(singleJobOptions, 100))
			.catch((err: unknown) => err);
		await vi.runAllTimersAsync();
		const caught: unknown = await settled;

		assert(caught instanceof Error);

		expect(caught.message).toBe(
			`Timed out waiting for Studio plugin connection on port 0. The plugin dials port ${DEFAULT_STUDIO_PORT.toString()} unless ReplicatedStorage sets the ${STUDIO_PORT_ATTRIBUTE} attribute to this port.`,
		);
	});

	it("should throw when the selected plugin never returns results", async () => {
		// Distinct from the connection timeout: a plugin was found and asked,
		// and then went quiet. Saying "waiting for a connection" here would
		// send the user looking for the wrong fault.
		expect.assertions(1);

		useSelectionTimers();
		const backend = new StudioBackend({ port: 0, webSocketServerFactory });
		const settled = backend
			.runTestsAsync(timed(singleJobOptions, 100))
			.catch((err: unknown) => err);

		connectPlugin({ wss: getLastCreatedServer()! });
		await vi.runAllTimersAsync();
		const caught: unknown = await settled;

		assert(caught instanceof Error);

		expect(caught.message).toBe("Timed out waiting for the Studio plugin to return results");
	});

	it("should end the run at one timeout, counted from before the plugin connected", async () => {
		expect.assertions(1);

		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		onTestFinished(() => {
			vi.useRealTimers();
		});
		const backend = new StudioBackend({ port: 0, webSocketServerFactory });
		const settled = backend
			.runTestsAsync(timed(singleJobOptions, 10_000))
			.catch((err: unknown) => err);

		await vi.advanceTimersByTimeAsync(6000);
		connectPlugin({ wss: getLastCreatedServer()! });
		await vi.advanceTimersByTimeAsync(4000);

		await expect(settled).resolves.toHaveProperty(
			"message",
			"Timed out waiting for the Studio plugin to return results",
		);
	});

	it("should accept results that arrive just before the one timeout ends", async () => {
		expect.assertions(1);

		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		onTestFinished(() => {
			vi.useRealTimers();
		});
		const backend = new StudioBackend({ port: 0, webSocketServerFactory });
		const settled = backend.runTestsAsync(timed(singleJobOptions, 10_000));

		await vi.advanceTimersByTimeAsync(6000);
		const socket = new MockWebSocket();
		let requestId = "";
		socket.send.mockImplementation((data) => {
			({ requestId } = runRequestSchema.assert(JSON.parse(data)));
		});
		connectPlugin({ socket, wss: getLastCreatedServer()! });
		await vi.advanceTimersByTimeAsync(3999);
		socket.emit(
			"message",
			Buffer.from(
				JSON.stringify({
					gameOutput: "[]",
					jestOutput: envelope([{ jestOutput: successResult() }]),
					protocolVersion: STUDIO_PROTOCOL_VERSION,
					requestId,
					type: "results",
				}),
			),
		);

		await expect(settled).resolves.toHaveProperty("rawResults", [expect.anything()]);
	});

	it("should throw when the plugin disconnects before sending results", async () => {
		expect.assertions(2);

		useSelectionTimers();

		const promise = startWithSocketAsync((socket) => {
			socket.emit("close");
		});

		await expect(promise).rejects.toThrowWithMessage(
			Error,
			"Studio plugin disconnected before sending results",
		);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("should reject when the plugin sends a malformed message", async () => {
		expect.assertions(1);

		const promise = startWithSocketAsync((socket) => {
			socket.emit("message", Buffer.from(JSON.stringify({ type: "wrong" })));
		});

		await expect(promise).rejects.toThrowWithMessage(Error, /Invalid plugin message/);
	});

	it("should reject when the websocket emits an error", async () => {
		expect.assertions(2);

		useSelectionTimers();

		const promise = startWithSocketAsync((socket) => {
			socket.emit("error", new Error("socket error"));
		});

		await expect(promise).rejects.toThrowWithMessage(Error, "socket error");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("should reject when the server emits an error", async () => {
		expect.assertions(1);

		const backend = new StudioBackend({
			port: 0,
			webSocketServerFactory,
		});
		const promise = backend.runTestsAsync(singleJobOptions);

		const wss = getLastCreatedServer()!;

		queueMicrotask(() => {
			wss.emit("error", new Error("server error"));
		});

		await expect(promise).rejects.toThrowWithMessage(Error, "server error");
	});

	it("should ignore messages whose requestId does not match", async () => {
		expect.assertions(1);

		const backend = new StudioBackend({
			port: 0,
			webSocketServerFactory,
		});
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
							protocolVersion: STUDIO_PROTOCOL_VERSION,
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
							protocolVersion: STUDIO_PROTOCOL_VERSION,
							requestId: message.requestId,
							type: "results",
						}),
					),
				);
			});
		});

		connectPlugin({ socket, wss });

		const { rawResults } = await promise;

		expect(rawResults).toHaveLength(1);
	});

	it("should reuse the same WebSocketServer across successive runTests calls", async () => {
		expect.assertions(2);

		const backend = new StudioBackend({
			port: 0,
			webSocketServerFactory,
		});

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

	it("should surface a top-level whole-run error instead of the count-mismatch guard", async () => {
		// Regression: a wholesale failure (e.g. LoadString disabled) returns a
		// bare {success:false, err} for the whole request, not one entry per job.
		// The entries-vs-jobs guard used to mask the real cause behind
		// "returned 1 entries but request had N jobs". The error must win.
		expect.assertions(2);

		const backend = new StudioBackend({
			port: 0,
			webSocketServerFactory,
		});
		const promise = backend.runTestsAsync(studioRequest({ jobs: [job("alpha"), job("beta")] }));

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

		const backend = new StudioBackend({
			port: 0,
			webSocketServerFactory,
		});
		const promise = backend.runTestsAsync(singleJobOptions);
		const wss = getLastCreatedServer()!;
		connectAndReply(wss, {});
		await promise;

		backend.closeAsync();

		expect(wss.close).toHaveBeenCalledExactlyOnceWith();

		// A second close() should no-op rather than double-closing.
		backend.closeAsync();

		expect(wss.close).toHaveBeenCalledExactlyOnceWith();
	});

	it("should listen on a real server when given no server factory", async () => {
		expect.assertions(1);

		const backend = new StudioBackend({ port: 0 });
		onTestFinished(() => {
			backend.closeAsync();
		});

		await expect(backend.runTestsAsync(timed(singleJobOptions, 1))).rejects.toThrowWithMessage(
			Error,
			/Timed out waiting for Studio plugin connection/,
		);
	});

	it("should terminate the connected plugin socket on close so the CLI can exit", async () => {
		// Regression: close() only closed the server, leaving the plugin socket
		// open. That open handle kept the Node event loop alive and hung the
		// CLI's process.exitCode-based shutdown whenever a Studio was detected.
		expect.assertions(1);

		const backend = new StudioBackend({
			port: 0,
			webSocketServerFactory,
		});
		const promise = backend.runTestsAsync(singleJobOptions);
		const wss = getLastCreatedServer()!;
		const socket = connectAndReply(wss, {});
		await promise;

		backend.closeAsync();

		expect(socket.terminate).toHaveBeenCalledExactlyOnceWith();
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

		const backend = new StudioBackend({
			port: 0,
			webSocketServerFactory,
		});
		const settled = backend.runTestsAsync(singleJobOptions).catch((err: unknown) => err);
		backend.closeAsync();

		const caught: unknown = await settled;
		assert(caught instanceof Error);

		expect(vi.getTimerCount()).toBe(0);
	});
});
