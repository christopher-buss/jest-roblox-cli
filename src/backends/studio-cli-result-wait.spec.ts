import { fromAny, fromPartial } from "@total-typescript/shoehorn";

import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import type { WebSocketServer } from "ws";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { MockWebSocketServer } from "#test/mocks/mock-web-socket-server.ts";
import { MockWebSocket } from "#test/mocks/mock-web-socket.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { ProjectJob } from "./interface.ts";
import {
	buildBackendResult,
	serverPortAsync,
	waitForResultAsync,
} from "./studio-cli-result-wait.ts";
import type { StudioCliProcess } from "./studio-cli-types.ts";

const JOB: ProjectJob = {
	config: { ...createResolvedConfig(), backend: "studio-cli", rootDir: "/repo" },
	displayName: "alpha",
	testFiles: ["alpha/test.spec.ts"],
};

const JEST_OUTPUT = JSON.stringify({
	entries: [{ jestOutput: JSON.stringify({ success: true }) }],
});

function result(fields: {
	pluginVersion?: string;
	protocolVersion?: number;
}): Parameters<typeof buildBackendResult>[0] {
	return { jestOutput: JEST_OUTPUT, requestId: "request-1", type: "results", ...fields };
}

function readResult(
	message: Parameters<typeof buildBackendResult>[0],
	manualPlugins: Array<string> = [],
) {
	return buildBackendResult(message, { executionMs: 5, jobs: [JOB], manualPlugins });
}

function pendingServer(boundPort: number | undefined): WebSocketServer {
	const server = new MockWebSocketServer({ port: 0 });
	const state = { listening: false };
	vi.spyOn(server, "address").mockImplementation(() => {
		if (boundPort !== undefined && state.listening) {
			return { port: boundPort };
		}

		return fromAny(null);
	});
	queueMicrotask(() => {
		state.listening = true;
		server.emit("listening");
	});
	return fromPartial(server);
}

describe(buildBackendResult, () => {
	it("should pair the decoded entries with the jobs and keep the timing", () => {
		expect.assertions(2);

		const backendResult = readResult(result({ protocolVersion: 10 }));

		expect(backendResult.rawResults).toHaveLength(1);
		expect(backendResult.timing).toStrictEqual({ executionMs: 5 });
	});

	it("should surface a version-mismatch error when the plugin omits the protocolVersion echo", () => {
		expect.assertions(1);

		expect(() => readResult(result({}))).toThrowWithMessage(
			Error,
			"studio-cli: jest-roblox Studio plugin protocol version mismatch " +
				"(plugin reported no version, CLI expects v10). " +
				"Update the jest-roblox Studio plugin to match this CLI version.",
		);
	});

	it("should surface a version-mismatch error when the plugin echoes a different protocolVersion", () => {
		expect.assertions(1);

		expect(() => readResult(result({ protocolVersion: 2 }))).toThrowWithMessage(
			Error,
			"studio-cli: jest-roblox Studio plugin protocol version mismatch " +
				"(plugin reported v2, CLI expects v10). " +
				"Update the jest-roblox Studio plugin to match this CLI version.",
		);
	});

	it("should name the release the answering plugin came from", () => {
		expect.assertions(1);

		expect(() => {
			return readResult(result({ pluginVersion: "0.3.18", protocolVersion: 5 }));
		}).toThrowWithMessage(
			Error,
			"studio-cli: jest-roblox Studio plugin protocol version mismatch " +
				"(plugin from jest-roblox 0.3.18 reported v5, CLI expects v10). " +
				"Update the jest-roblox Studio plugin to match this CLI version.",
		);
	});

	it("should name the manual plugins that can answer in place of the managed one", () => {
		expect.assertions(1);

		expect(() => {
			return readResult(result({ pluginVersion: "0.3.18", protocolVersion: 5 }), [
				"JestRobloxRunner.rbxm",
				"jest-old.rbxm",
			]);
		}).toThrowWithMessage(
			Error,
			"studio-cli: jest-roblox Studio plugin protocol version mismatch " +
				"(plugin from jest-roblox 0.3.18 reported v5, CLI expects v10). " +
				"Remove or update these copies in the Studio plugins folder: " +
				"JestRobloxRunner.rbxm, jest-old.rbxm.",
		);
	});
});

describe(serverPortAsync, () => {
	it("should wait for `listening` and read the assigned ephemeral port", async () => {
		expect.assertions(1);

		await expect(serverPortAsync(pendingServer(54_321))).resolves.toBe(54_321);
	});

	it("should throw when the result server never reports a bound port", async () => {
		expect.assertions(1);

		await expect(serverPortAsync(pendingServer(undefined))).rejects.toThrow(
			/failed to bind a port/,
		);
	});
});

describe(waitForResultAsync, () => {
	it("should resolve with the result for its own request only", async () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();
		const server = new MockWebSocketServer({ port: 0 });
		const child: StudioCliProcess = {
			kill: vi.fn<() => void>(),
			killOnLockRelease: vi.fn<(graceCapMs: number) => void>(),
			onError: vi.fn<StudioCliProcess["onError"]>(),
		};
		const waiting = waitForResultAsync({
			child,
			deadline: { bootTimeout: 0, outputFile: "/repo/output.log", timeout: 0 },
			fileSystem,
			pluginKey: undefined,
			requestId: "request-1",
			server: fromPartial(server),
		});
		const socket = new MockWebSocket();
		server.emit("connection", socket);
		for (const frame of [
			"not json",
			JSON.stringify({ ...result({}), requestId: "request-2" }),
			JSON.stringify(result({ protocolVersion: 10 })),
		]) {
			socket.emit("message", Buffer.from(frame));
		}

		await expect(waiting).resolves.toStrictEqual(result({ protocolVersion: 10 }));
	});
});
