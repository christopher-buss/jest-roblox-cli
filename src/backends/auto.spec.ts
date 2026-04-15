import { fromPartial } from "@total-typescript/shoehorn";

import { assert, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import { DEFAULT_CONFIG } from "../config/schema.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import { LuauScriptError } from "../reporter/parser.ts";
import {
	isStudioBusyError,
	probeStudioPlugin,
	resolveBackend,
	StudioWithFallback,
} from "./auto.ts";
import type { ProbeDetected, ProbeResult } from "./auto.ts";
import type { Backend } from "./interface.ts";
import { OpenCloudBackend } from "./open-cloud.ts";
import { StudioBackend } from "./studio.ts";

const { getLastCreatedServer, MockWebSocket, MockWebSocketServer } = await vi.hoisted(
	async () => import("../../test/mocks/mock-ws"),
);

vi.mock(import("ws"), async () => fromPartial({ WebSocketServer: MockWebSocketServer }));

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return { ...DEFAULT_CONFIG, ...overrides };
}

describe(probeStudioPlugin, () => {
	it("should return detected with server and socket when plugin connects", async () => {
		expect.assertions(2);

		const mockSocket = new MockWebSocket();
		const promise = probeStudioPlugin(0, 2000);

		const wss = getLastCreatedServer();
		assert(wss, "expected server to be created");
		wss.emit("connection", mockSocket);

		const result = await promise;

		assert(result.detected, "expected probe to detect plugin");

		expect(result.server).toBe(wss);
		expect(result.socket).toBe(mockSocket);
	});

	it("should return not detected when no connection within timeout", async () => {
		expect.assertions(1);

		const result = await probeStudioPlugin(0, 50);

		expect(result.detected).toBeFalse();
	});

	it("should return not detected when WSS emits error", async () => {
		expect.assertions(1);

		const promise = probeStudioPlugin(0, 5000);

		const wss = getLastCreatedServer();
		assert(wss, "expected server to be created");
		wss.emit("error", new Error("EADDRINUSE"));

		const result = await promise;

		expect(result.detected).toBeFalse();
	});

	it("should close server when timeout expires", async () => {
		expect.assertions(1);

		await probeStudioPlugin(0, 50);

		expect(getLastCreatedServer()?.close).toHaveBeenCalledWith();
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

describe(resolveBackend, () => {
	it("should select studio backend when plugin available and no OC credentials", async () => {
		expect.assertions(1);

		vi.stubEnv("ROBLOX_OPEN_CLOUD_API_KEY", undefined);
		vi.stubEnv("ROBLOX_UNIVERSE_ID", undefined);
		vi.stubEnv("ROBLOX_PLACE_ID", undefined);

		const backend = await resolveBackend(makeConfig({ backend: "auto" }), async () =>
			mockDetected(),
		);

		expect(backend).toBeInstanceOf(StudioBackend);

		vi.unstubAllEnvs();
	});

	it("should fall back to open-cloud when plugin unavailable", async () => {
		expect.assertions(1);

		vi.stubEnv("ROBLOX_OPEN_CLOUD_API_KEY", "test-key");
		vi.stubEnv("ROBLOX_UNIVERSE_ID", "123");
		vi.stubEnv("ROBLOX_PLACE_ID", "456");

		async function probe(): Promise<ProbeResult> {
			return mockNotDetected();
		}

		const backend = await resolveBackend(makeConfig({ backend: "auto" }), probe);

		expect(backend).toBeInstanceOf(OpenCloudBackend);

		vi.unstubAllEnvs();
	});

	it("should throw when auto mode has no OC env vars and no studio", async () => {
		expect.assertions(1);

		vi.stubEnv("ROBLOX_OPEN_CLOUD_API_KEY", undefined);
		vi.stubEnv("ROBLOX_UNIVERSE_ID", undefined);
		vi.stubEnv("ROBLOX_PLACE_ID", undefined);

		await expect(
			resolveBackend(makeConfig({ backend: "auto" }), async () => mockNotDetected()),
		).rejects.toThrowWithMessage(Error, /No backend available/);

		vi.unstubAllEnvs();
	});

	it("should return studio backend for explicit studio config", async () => {
		expect.assertions(1);

		const probe =
			vi.fn<(port: number, timeoutMs: number) => Promise<ProbeDetected | ProbeResult>>();
		const backend = await resolveBackend(makeConfig({ backend: "studio" }), probe);

		expect(backend).toBeInstanceOf(StudioBackend);
	});

	it("should return open-cloud backend for explicit open-cloud config", async () => {
		expect.assertions(1);

		vi.stubEnv("ROBLOX_OPEN_CLOUD_API_KEY", "test-key");
		vi.stubEnv("ROBLOX_UNIVERSE_ID", "123");
		vi.stubEnv("ROBLOX_PLACE_ID", "456");

		const probe =
			vi.fn<(port: number, timeoutMs: number) => Promise<ProbeDetected | ProbeResult>>();
		const backend = await resolveBackend(makeConfig({ backend: "open-cloud" }), probe);

		expect(backend).toBeInstanceOf(OpenCloudBackend);

		vi.unstubAllEnvs();
	});

	it("should wrap studio with fallback when OC credentials available", async () => {
		expect.assertions(1);

		vi.stubEnv("ROBLOX_OPEN_CLOUD_API_KEY", "test-key");
		vi.stubEnv("ROBLOX_UNIVERSE_ID", "123");
		vi.stubEnv("ROBLOX_PLACE_ID", "456");

		const backend = await resolveBackend(makeConfig({ backend: "auto" }), async () =>
			mockDetected(),
		);

		expect(backend).toBeInstanceOf(StudioWithFallback);

		vi.unstubAllEnvs();
	});
});

describe(isStudioBusyError, () => {
	it("should match EADDRINUSE errors", () => {
		expect.assertions(1);

		const error = Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });

		expect(isStudioBusyError(error)).toBeTrue();
	});

	it("should match StudioTestService busy errors", () => {
		expect.assertions(1);

		const error = new LuauScriptError(
			"StudioTestService: Previous call to start play session has not been completed",
		);

		expect(isStudioBusyError(error)).toBeTrue();
	});

	it("should not match unrelated errors", () => {
		expect.assertions(1);

		expect(isStudioBusyError(new Error("something else"))).toBeFalse();
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
			runTests: vi
				.fn<Backend["runTests"]>()
				.mockRejectedValue(
					Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" }),
				),
		};

		const fallback = new StudioWithFallback(studioBackend);

		// Will throw because OC env vars are stubs, but it proves the fallback
		// path runs
		await expect(
			fallback.runTests({
				jobs: [
					{
						config: makeConfig({ backend: "auto" }),
						displayName: "",
						testFiles: ["test.spec.ts"],
					},
				],
			}),
		).rejects.toThrow(/game\.rbxl/);

		vi.unstubAllEnvs();
	});

	it("should delegate close() to the wrapped studio backend", async () => {
		expect.assertions(1);

		const close = vi.fn<() => void>();
		const studioBackend: Backend = {
			close,
			kind: "studio",
			runTests: vi.fn<Backend["runTests"]>(),
		};

		const fallback = new StudioWithFallback(studioBackend);
		await fallback.close();

		expect(close).toHaveBeenCalledOnce();
	});

	it("should rethrow non-busy errors", async () => {
		expect.assertions(1);

		const studioBackend: Backend = {
			kind: "studio",
			runTests: vi.fn<Backend["runTests"]>().mockRejectedValue(new Error("some other error")),
		};

		const fallback = new StudioWithFallback(studioBackend);

		await expect(
			fallback.runTests({
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
