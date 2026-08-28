import { fromPartial } from "@total-typescript/shoehorn";

import { Buffer } from "node:buffer";
import process from "node:process";
import { assert, describe, expect, it, onTestFinished, vi } from "vitest";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";

import type { MockWebSocket as MockWebSocketType } from "../../test/mocks/mock-web-socket.ts";
import { DEFAULT_CONFIG } from "../config/schema.ts";
import type { CliOptions, ResolvedConfig } from "../config/schema.ts";
import { LuauScriptError } from "../reporter/parser.ts";
import { probeStudioPluginAsync, resolveBackendAsync, StudioWithFallback } from "./auto.ts";
import type { ProbeDetected, ProbeResult } from "./auto.ts";
import type { Backend } from "./interface.ts";
import { OpenCloudBackend } from "./open-cloud.ts";
import { PluginConnectionPool } from "./plugin-connections.ts";
import { StudioCliBackend } from "./studio-cli.ts";
import { StudioBackend } from "./studio.ts";

const { getLastCreatedServer, MockWebSocket, MockWebSocketServer } = await vi.hoisted(
	async () => import("../../test/mocks/mock-ws"),
);

vi.mock(import("ws"), async () => fromPartial({ WebSocketServer: MockWebSocketServer }));

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return { ...DEFAULT_CONFIG, ...overrides };
}

function makeCli(overrides: Partial<CliOptions> = {}): CliOptions {
	return overrides;
}

function useProbeTimers(): void {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	onTestFinished(() => {
		vi.useRealTimers();
	});
}

// The protocol the probe selects on, pinned here rather than imported: the
// spec asserts the wire a real plugin puts on it.
const PROTOCOL_VERSION = 6;

/** Connect a plugin and let it announce itself, the way a real one does. */
function connectPlugin(
	wss: { emit: (event: string, payload: unknown) => void },
	hello: Record<string, unknown> = {},
): MockWebSocketType {
	const socket = new MockWebSocket();
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

describe(probeStudioPluginAsync, () => {
	it("should return detected with server and socket when plugin connects", async () => {
		expect.assertions(5);

		useProbeTimers();
		const promise = probeStudioPluginAsync(4321, 2000);

		const wss = getLastCreatedServer();
		assert(wss, "expected server to be created");
		const mockSocket = connectPlugin(wss);

		const result = await promise;

		assert(result.detected === true, "expected probe to detect plugin");

		expect(result.server).toBe(fromPartial<WebSocketServer>(wss));
		expect(result.socket).toBe(fromPartial<WebSocket>(mockSocket));
		expect(wss.port).toBe(4321);
		expect(wss.close).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("should return not detected when no connection within timeout", async () => {
		expect.assertions(1);

		useProbeTimers();

		const promise = probeStudioPluginAsync(0, 50);
		await vi.runAllTimersAsync();
		const result = await promise;

		expect(result.detected).toBeFalse();
	});

	it("should return not detected when WSS emits error", async () => {
		expect.assertions(3);

		useProbeTimers();
		const promise = probeStudioPluginAsync(0, 5000);

		const wss = getLastCreatedServer();
		assert(wss, "expected server to be created");
		wss.emit("error", new Error("EADDRINUSE"));

		const result = await promise;

		expect(result.detected).toBeFalse();
		expect(wss.close).toHaveBeenCalledExactlyOnceWith();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("should close server when timeout expires", async () => {
		expect.assertions(1);

		useProbeTimers();

		const promise = probeStudioPluginAsync(0, 50);
		await vi.runAllTimersAsync();
		await promise;

		expect(getLastCreatedServer()!.close).toHaveBeenCalledWith();
	});

	it("should report every connection as incompatible when none match", async () => {
		// Several installed copies, all stale. The server stays open so the
		// caller can name each one in its error.
		expect.assertions(3);

		useProbeTimers();
		const promise = probeStudioPluginAsync(0, 5000);

		const wss = getLastCreatedServer();
		assert(wss, "expected server to be created");
		connectPlugin(wss, { protocolVersion: PROTOCOL_VERSION - 1 });
		connectPlugin(wss, { protocolVersion: PROTOCOL_VERSION - 2 });
		await vi.runAllTimersAsync();

		const result = await promise;

		assert(result.detected === "incompatible", "expected an incompatible probe result");

		expect(result.candidates).toHaveLength(2);
		expect(result.candidates[0]!.hello!.protocolVersion).toBe(PROTOCOL_VERSION - 1);
		expect(wss.close).not.toHaveBeenCalled();
	});

	it("should detect the one matching plugin among stale ones", async () => {
		expect.assertions(1);

		useProbeTimers();
		const promise = probeStudioPluginAsync(0, 5000);

		const wss = getLastCreatedServer();
		assert(wss, "expected server to be created");
		connectPlugin(wss, { protocolVersion: PROTOCOL_VERSION - 1 });
		const current = connectPlugin(wss);

		const result = await promise;

		assert(result.detected === true, "expected probe to detect plugin");

		expect(result.socket).toBe(fromPartial<WebSocket>(current));
	});
});

function mockDetected(): ProbeDetected {
	const server = new WebSocketServer({ port: 0 });
	return {
		detected: true,
		pool: new PluginConnectionPool(server),
		server,
		socket: fromPartial(new MockWebSocket()),
	};
}

function mockNotDetected(): ProbeResult {
	return { detected: false };
}

describe(resolveBackendAsync, () => {
	it("should select studio backend when plugin available and no OC credentials", async () => {
		expect.assertions(3);

		vi.stubEnv("ROBLOX_OPEN_CLOUD_API_KEY", undefined);
		vi.stubEnv("ROBLOX_UNIVERSE_ID", undefined);
		vi.stubEnv("ROBLOX_PLACE_ID", undefined);
		vi.stubEnv("JEST_ROBLOX_OPEN_CLOUD_API_KEY", undefined);
		vi.stubEnv("JEST_ROBLOX_UNIVERSE_ID", undefined);
		vi.stubEnv("JEST_ROBLOX_PLACE_ID", undefined);

		const probeAsync = vi.fn<() => Promise<ProbeDetected>>(async () => mockDetected());
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		const backend = await resolveBackendAsync(
			makeCli(),
			makeConfig({ backend: "auto" }),
			probeAsync,
		);

		expect(backend).toBeInstanceOf(StudioBackend);
		expect(probeAsync).toHaveBeenCalledExactlyOnceWith(DEFAULT_CONFIG.port, 500);
		expect(stderr).toHaveBeenCalledExactlyOnceWith("Backend: studio (plugin detected)\n");
	});

	it("should throw rather than fall back when the connected plugins are incompatible", async () => {
		// A plugin that is present but unusable is something to fix. Falling
		// back would run different code against a different place under a
		// backend the user did not choose, and hide the bad install doing it.
		expect.assertions(3);

		vi.stubEnv("ROBLOX_OPEN_CLOUD_API_KEY", "test-key");
		vi.stubEnv("ROBLOX_UNIVERSE_ID", "123");
		vi.stubEnv("ROBLOX_PLACE_ID", "456");

		const server = new MockWebSocketServer({ port: 0 });
		const socket = new MockWebSocket();
		server.emit("connection", socket);

		await expect(
			resolveBackendAsync(makeCli(), makeConfig({ backend: "auto" }), async () => {
				return {
					candidates: [
						{
							hello: {
								pluginName: "JestRobloxRunner",
								pluginVersion: "0.3.18",
								protocolVersion: 5,
								type: "hello" as const,
							},
							socket: fromPartial<WebSocket>(socket),
						},
					],
					detected: "incompatible" as const,
					server: fromPartial<WebSocketServer>(server),
				};
			}),
		).rejects.toThrow(/No compatible jest-roblox Studio plugin/);

		// The live socket has to go, or it keeps the event loop alive and the
		// CLI never exits to print the error.
		expect(socket.terminate).toHaveBeenCalledOnce();
		expect(server.close).toHaveBeenCalledOnce();
	});

	it("should fall back to open-cloud when plugin unavailable", async () => {
		expect.assertions(2);

		vi.stubEnv("ROBLOX_OPEN_CLOUD_API_KEY", "test-key");
		vi.stubEnv("ROBLOX_UNIVERSE_ID", "123");
		vi.stubEnv("ROBLOX_PLACE_ID", "456");

		async function probeAsync(): Promise<ProbeResult> {
			return mockNotDetected();
		}

		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		const backend = await resolveBackendAsync(
			makeCli(),
			makeConfig({ backend: "auto" }),
			probeAsync,
		);

		expect(backend).toBeInstanceOf(OpenCloudBackend);
		expect(stderr).toHaveBeenCalledExactlyOnceWith(
			"Backend: open-cloud (no plugin, using Open Cloud)\n",
		);
	});

	it("should select open-cloud when only JEST_ROBLOX_* env vars are set", async () => {
		expect.assertions(1);

		vi.stubEnv("ROBLOX_OPEN_CLOUD_API_KEY", undefined);
		vi.stubEnv("ROBLOX_UNIVERSE_ID", undefined);
		vi.stubEnv("ROBLOX_PLACE_ID", undefined);
		vi.stubEnv("JEST_ROBLOX_OPEN_CLOUD_API_KEY", "jest-key");
		vi.stubEnv("JEST_ROBLOX_UNIVERSE_ID", "888");
		vi.stubEnv("JEST_ROBLOX_PLACE_ID", "999");

		async function probeAsync(): Promise<ProbeResult> {
			return mockNotDetected();
		}

		const backend = await resolveBackendAsync(
			makeCli(),
			makeConfig({ backend: "auto" }),
			probeAsync,
		);

		expect(backend).toBeInstanceOf(OpenCloudBackend);
	});

	it("should throw when auto mode has no OC env vars and no studio", async () => {
		expect.assertions(1);

		vi.stubEnv("ROBLOX_OPEN_CLOUD_API_KEY", undefined);
		vi.stubEnv("ROBLOX_UNIVERSE_ID", undefined);
		vi.stubEnv("ROBLOX_PLACE_ID", undefined);
		vi.stubEnv("JEST_ROBLOX_OPEN_CLOUD_API_KEY", undefined);
		vi.stubEnv("JEST_ROBLOX_UNIVERSE_ID", undefined);
		vi.stubEnv("JEST_ROBLOX_PLACE_ID", undefined);

		await expect(
			resolveBackendAsync(makeCli(), makeConfig({ backend: "auto" }), async () => {
				return mockNotDetected();
			}),
		).rejects.toThrowWithMessage(
			Error,
			"No backend available: Studio plugin not detected and no Open Cloud " +
				"credentials found. Set ROBLOX_OPEN_CLOUD_API_KEY, ROBLOX_UNIVERSE_ID, " +
				"and ROBLOX_PLACE_ID (or pass --apiKey, --universeId, --placeId; " +
				"or set universeId/placeId in jest.config.ts).",
		);
	});

	it("should return studio backend for explicit studio config", async () => {
		expect.assertions(1);

		const probe =
			vi.fn<(port: number, timeoutMs: number) => Promise<ProbeDetected | ProbeResult>>();
		const backend = await resolveBackendAsync(
			makeCli(),
			makeConfig({ backend: "studio" }),
			probe,
		);

		expect(backend).toBeInstanceOf(StudioBackend);
	});

	it("should return studio-cli backend for explicit studio-cli config", async () => {
		expect.assertions(1);

		const probe =
			vi.fn<(port: number, timeoutMs: number) => Promise<ProbeDetected | ProbeResult>>();
		const backend = await resolveBackendAsync(
			makeCli(),
			makeConfig({ backend: "studio-cli" }),
			probe,
		);

		expect(backend).toBeInstanceOf(StudioCliBackend);
	});

	it("should never select studio-cli from the auto probe chain", async () => {
		expect.assertions(1);

		async function probeAsync(): Promise<ProbeDetected> {
			return mockDetected();
		}

		const backend = await resolveBackendAsync(
			makeCli(),
			makeConfig({ backend: "auto" }),
			probeAsync,
		);

		expect(backend).not.toBeInstanceOf(StudioCliBackend);
	});

	it("should reject --parallel > 1 for studio-cli with a clear message", async () => {
		expect.assertions(1);

		const probe =
			vi.fn<(port: number, timeoutMs: number) => Promise<ProbeDetected | ProbeResult>>();

		await expect(
			resolveBackendAsync(
				makeCli(),
				makeConfig({ backend: "studio-cli", parallel: 2 }),
				probe,
			),
		).rejects.toThrowWithMessage(
			Error,
			"studio-cli backend is serial (one Studio instance); --parallel > 1 is not supported.",
		);
	});

	it("should accept --parallel auto for studio-cli, which needs one session", async () => {
		expect.assertions(1);

		const probe =
			vi.fn<(port: number, timeoutMs: number) => Promise<ProbeDetected | ProbeResult>>();

		const backend = await resolveBackendAsync(
			makeCli(),
			makeConfig({ backend: "studio-cli", parallel: "auto" }),
			probe,
		);

		expect(backend).toBeInstanceOf(StudioCliBackend);
	});

	it("should reject --experimental-vm-parallel on the open-cloud backend", async () => {
		expect.assertions(1);

		vi.stubEnv("ROBLOX_OPEN_CLOUD_API_KEY", "test-key");
		vi.stubEnv("ROBLOX_UNIVERSE_ID", "123");
		vi.stubEnv("ROBLOX_PLACE_ID", "456");

		const probe =
			vi.fn<(port: number, timeoutMs: number) => Promise<ProbeDetected | ProbeResult>>();

		await expect(
			resolveBackendAsync(
				makeCli(),
				makeConfig({ backend: "open-cloud", experimentalVmParallel: 2 }),
				probe,
			),
		).rejects.toThrow(/--experimental-vm-parallel is Studio-only/);
	});

	it("should accept --experimental-vm-parallel on the studio backend", async () => {
		expect.assertions(1);

		const probe =
			vi.fn<(port: number, timeoutMs: number) => Promise<ProbeDetected | ProbeResult>>();

		const backend = await resolveBackendAsync(
			makeCli(),
			makeConfig({ backend: "studio", experimentalVmParallel: "auto" }),
			probe,
		);

		expect(backend.kind).toBe("studio");
	});

	it("should reject an explicit VM count above the hosts the plugin ships", async () => {
		expect.assertions(1);

		const probe =
			vi.fn<(port: number, timeoutMs: number) => Promise<ProbeDetected | ProbeResult>>();

		await expect(
			resolveBackendAsync(
				makeCli(),
				makeConfig({ backend: "studio", experimentalVmParallel: 8 }),
				probe,
			),
		).rejects.toThrow(/ships 4 VM hosts/);
	});

	it("should accept a VM count equal to the host pool", async () => {
		expect.assertions(1);

		const probe =
			vi.fn<(port: number, timeoutMs: number) => Promise<ProbeDetected | ProbeResult>>();

		const backend = await resolveBackendAsync(
			makeCli(),
			makeConfig({ backend: "studio", experimentalVmParallel: 4 }),
			probe,
		);

		expect(backend.kind).toBe("studio");
	});

	it("should return open-cloud backend for explicit open-cloud config", async () => {
		expect.assertions(1);

		vi.stubEnv("ROBLOX_OPEN_CLOUD_API_KEY", "test-key");
		vi.stubEnv("ROBLOX_UNIVERSE_ID", "123");
		vi.stubEnv("ROBLOX_PLACE_ID", "456");

		const probe =
			vi.fn<(port: number, timeoutMs: number) => Promise<ProbeDetected | ProbeResult>>();
		const backend = await resolveBackendAsync(
			makeCli(),
			makeConfig({ backend: "open-cloud" }),
			probe,
		);

		expect(backend).toBeInstanceOf(OpenCloudBackend);
	});

	it("should throw precise resolver error when user supplies partial CLI overrides", async () => {
		expect.assertions(2);

		vi.stubEnv("ROBLOX_OPEN_CLOUD_API_KEY", undefined);
		vi.stubEnv("ROBLOX_UNIVERSE_ID", undefined);
		vi.stubEnv("ROBLOX_PLACE_ID", undefined);
		vi.stubEnv("JEST_ROBLOX_OPEN_CLOUD_API_KEY", undefined);
		vi.stubEnv("JEST_ROBLOX_UNIVERSE_ID", undefined);
		vi.stubEnv("JEST_ROBLOX_PLACE_ID", undefined);

		async function probeAsync(): Promise<ProbeResult> {
			return mockNotDetected();
		}

		await expect(
			resolveBackendAsync(
				makeCli({ apiKey: "key" }),
				makeConfig({ backend: "auto" }),
				probeAsync,
			),
		).rejects.toThrowWithMessage(Error, /Missing: universeId, placeId/);
		await expect(
			resolveBackendAsync(
				makeCli({ apiKey: "key" }),
				makeConfig({ backend: "auto" }),
				probeAsync,
			),
		).rejects.toThrowWithMessage(
			Error,
			/Set ROBLOX_UNIVERSE_ID \(or JEST_ROBLOX_UNIVERSE_ID\), ROBLOX_PLACE_ID \(or JEST_ROBLOX_PLACE_ID\)/,
		);
	});

	it.for([makeCli({ universeId: "123" }), makeCli({ placeId: "456" })])(
		"should surface credential errors for every kind of partial CLI override",
		async (cli) => {
			expect.assertions(1);

			vi.stubEnv("ROBLOX_OPEN_CLOUD_API_KEY", undefined);
			vi.stubEnv("ROBLOX_UNIVERSE_ID", undefined);
			vi.stubEnv("ROBLOX_PLACE_ID", undefined);
			vi.stubEnv("JEST_ROBLOX_OPEN_CLOUD_API_KEY", undefined);
			vi.stubEnv("JEST_ROBLOX_UNIVERSE_ID", undefined);
			vi.stubEnv("JEST_ROBLOX_PLACE_ID", undefined);

			await expect(
				resolveBackendAsync(cli, makeConfig({ backend: "auto" }), async () => {
					return mockNotDetected();
				}),
			).rejects.toThrow(/Missing:/);
		},
	);

	it("should wrap studio with fallback when OC credentials available", async () => {
		expect.assertions(1);

		vi.stubEnv("ROBLOX_OPEN_CLOUD_API_KEY", "test-key");
		vi.stubEnv("ROBLOX_UNIVERSE_ID", "123");
		vi.stubEnv("ROBLOX_PLACE_ID", "456");

		async function probeAsync(): Promise<ProbeDetected> {
			return mockDetected();
		}

		const backend = await resolveBackendAsync(
			makeCli(),
			makeConfig({ backend: "auto" }),
			probeAsync,
		);

		expect(backend).toBeInstanceOf(StudioWithFallback);
	});
});

describe(StudioWithFallback, () => {
	it("should fall back to open-cloud on EADDRINUSE", async () => {
		expect.assertions(1);

		vi.stubEnv("ROBLOX_OPEN_CLOUD_API_KEY", "test-key");
		vi.stubEnv("ROBLOX_UNIVERSE_ID", "123");
		vi.stubEnv("ROBLOX_PLACE_ID", "456");

		const studioBackend: Backend = {
			kind: "studio",
			runTestsAsync: vi
				.fn<Backend["runTestsAsync"]>()
				.mockRejectedValue(
					Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" }),
				),
		};

		const fallback = new StudioWithFallback(studioBackend, {
			apiKey: "test-key",
			placeId: "456",
			universeId: "123",
		});

		// Will throw because OC env vars are stubs, but it proves the fallback
		// path runs
		await expect(
			fallback.runTestsAsync({
				jobs: [
					{
						config: makeConfig({ backend: "auto" }),
						displayName: "",
						testFiles: ["test.spec.ts"],
					},
				],
			}),
		).rejects.toThrow(/game\.rbxl/);
	});

	it("should fall back to open-cloud when StudioTestService is busy", async () => {
		expect.assertions(1);

		vi.stubEnv("ROBLOX_OPEN_CLOUD_API_KEY", "test-key");
		vi.stubEnv("ROBLOX_UNIVERSE_ID", "123");
		vi.stubEnv("ROBLOX_PLACE_ID", "456");

		const studioBackend: Backend = {
			kind: "studio",
			runTestsAsync: vi
				.fn<Backend["runTestsAsync"]>()
				.mockRejectedValue(
					new LuauScriptError(
						"StudioTestService: Previous call to start play session has not been completed",
					),
				),
		};

		const fallback = new StudioWithFallback(studioBackend, {
			apiKey: "test-key",
			placeId: "456",
			universeId: "123",
		});

		await expect(
			fallback.runTestsAsync({
				jobs: [
					{
						config: makeConfig({ backend: "auto" }),
						displayName: "",
						testFiles: ["test.spec.ts"],
					},
				],
			}),
		).rejects.toThrow(/game\.rbxl/);
	});

	it("should delegate close() to the wrapped studio backend", async () => {
		expect.assertions(1);

		const close = vi.fn<() => void>();
		const studioBackend: Backend = {
			closeAsync: close,
			kind: "studio",
			runTestsAsync: vi.fn<Backend["runTestsAsync"]>(),
		};

		const fallback = new StudioWithFallback(studioBackend, {
			apiKey: "test-key",
			placeId: "456",
			universeId: "123",
		});
		await fallback.closeAsync();

		expect(close).toHaveBeenCalledOnce();
	});

	it("should rethrow non-busy errors", async () => {
		expect.assertions(1);

		const studioBackend: Backend = {
			kind: "studio",
			runTestsAsync: vi
				.fn<Backend["runTestsAsync"]>()
				.mockRejectedValue(new Error("some other error")),
		};

		const fallback = new StudioWithFallback(studioBackend, {
			apiKey: "test-key",
			placeId: "456",
			universeId: "123",
		});

		await expect(
			fallback.runTestsAsync({
				jobs: [
					{
						config: makeConfig({ backend: "auto" }),
						displayName: "",
						testFiles: ["test.spec.ts"],
					},
				],
			}),
		).rejects.toThrowWithMessage(Error, "some other error");
	});
});
