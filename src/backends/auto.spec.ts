import { fromPartial } from "@total-typescript/shoehorn";

import { assert, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";

import { DEFAULT_CONFIG } from "../config/schema.ts";
import type { CliOptions, ResolvedConfig } from "../config/schema.ts";
import { LuauScriptError } from "../reporter/parser.ts";
import { probeStudioPluginAsync, resolveBackendAsync, StudioWithFallback } from "./auto.ts";
import type { ProbeDetected, ProbeResult } from "./auto.ts";
import type { Backend } from "./interface.ts";
import { OpenCloudBackend } from "./open-cloud.ts";
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

describe(probeStudioPluginAsync, () => {
	it("should return detected with server and socket when plugin connects", async () => {
		expect.assertions(2);

		const mockSocket = new MockWebSocket();
		const promise = probeStudioPluginAsync(0, 2000);

		const wss = getLastCreatedServer();
		assert(wss, "expected server to be created");
		wss.emit("connection", mockSocket);

		const result = await promise;

		assert(result.detected, "expected probe to detect plugin");

		expect(result.server).toBe(fromPartial<WebSocketServer>(wss));
		expect(result.socket).toBe(fromPartial<WebSocket>(mockSocket));
	});

	it("should return not detected when no connection within timeout", async () => {
		expect.assertions(1);

		const result = await probeStudioPluginAsync(0, 50);

		expect(result.detected).toBeFalse();
	});

	it("should return not detected when WSS emits error", async () => {
		expect.assertions(1);

		const promise = probeStudioPluginAsync(0, 5000);

		const wss = getLastCreatedServer();
		assert(wss, "expected server to be created");
		wss.emit("error", new Error("EADDRINUSE"));

		const result = await promise;

		expect(result.detected).toBeFalse();
	});

	it("should close server when timeout expires", async () => {
		expect.assertions(1);

		await probeStudioPluginAsync(0, 50);

		expect(getLastCreatedServer()!.close).toHaveBeenCalledWith();
	});
});

function mockDetected(): ProbeDetected {
	return {
		detected: true,
		server: new WebSocketServer({ port: 0 }),
		socket: fromPartial(new MockWebSocket()),
	};
}

function mockNotDetected(): ProbeResult {
	return { detected: false };
}

describe(resolveBackendAsync, () => {
	it("should select studio backend when plugin available and no OC credentials", async () => {
		expect.assertions(1);

		vi.stubEnv("ROBLOX_OPEN_CLOUD_API_KEY", undefined);
		vi.stubEnv("ROBLOX_UNIVERSE_ID", undefined);
		vi.stubEnv("ROBLOX_PLACE_ID", undefined);
		vi.stubEnv("JEST_ROBLOX_OPEN_CLOUD_API_KEY", undefined);
		vi.stubEnv("JEST_ROBLOX_UNIVERSE_ID", undefined);
		vi.stubEnv("JEST_ROBLOX_PLACE_ID", undefined);

		async function probeAsync(): Promise<ProbeDetected> {
			return mockDetected();
		}

		const backend = await resolveBackendAsync(
			makeCli(),
			makeConfig({ backend: "auto" }),
			probeAsync,
		);

		expect(backend).toBeInstanceOf(StudioBackend);
	});

	it("should fall back to open-cloud when plugin unavailable", async () => {
		expect.assertions(1);

		vi.stubEnv("ROBLOX_OPEN_CLOUD_API_KEY", "test-key");
		vi.stubEnv("ROBLOX_UNIVERSE_ID", "123");
		vi.stubEnv("ROBLOX_PLACE_ID", "456");

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
		).rejects.toThrowWithMessage(Error, /No backend available/);
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
		).rejects.toThrow(/--parallel > 1 is not supported/);
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
