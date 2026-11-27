import { fromPartial } from "@total-typescript/shoehorn";

import { Buffer } from "node:buffer";
import { assert, describe, it, type TestContext, vi } from "vitest";
import type { WebSocket, WebSocketServer } from "ws";

import { MockWebSocketServer } from "#test/helpers/unit/mock-web-socket-server.ts";
import { MockWebSocket } from "#test/helpers/unit/mock-web-socket.ts";
import packageJson from "../../package.json" with { type: "json" };
import {
	closePluginServer,
	describePluginMismatch,
	type PluginCandidate,
	PluginConnectionPool,
} from "./plugin-connections.ts";

const EXPECTED_VERSION = 6;

const REQUEST = { connectTimeoutMs: 40, expectedVersion: EXPECTED_VERSION, graceMs: 10 };

function useFakeTimers(onTestFinished: TestContext["onTestFinished"]): void {
	vi.useFakeTimers();
	onTestFinished(() => {
		vi.useRealTimers();
	});
}

function makePool(onTestFinished: TestContext["onTestFinished"]): {
	pool: PluginConnectionPool;
	wss: MockWebSocketServer;
} {
	useFakeTimers(onTestFinished);
	const wss = new MockWebSocketServer({ port: 0 });
	return { pool: new PluginConnectionPool(fromPartial<WebSocketServer>(wss)), wss };
}

function connectSilent(wss: MockWebSocketServer): MockWebSocket {
	const socket = new MockWebSocket();
	wss.emit("connection", socket);
	return socket;
}

function send(socket: MockWebSocket, encoded: string): void {
	socket.emit("message", Buffer.from(encoded));
}

async function waitAsync(): Promise<void> {
	await vi.advanceTimersByTimeAsync(60);
}

async function afterAsync<T>(ms: number, promise: Promise<T>): Promise<T> {
	await vi.advanceTimersByTimeAsync(ms);
	return promise;
}

function connectPlugin(
	wss: MockWebSocketServer,
	hello: Record<string, unknown> = {},
): MockWebSocket {
	const socket = connectSilent(wss);
	send(
		socket,
		JSON.stringify({
			pluginName: "JestRobloxRunner",
			pluginVersion: "9.9.9",
			protocolVersion: EXPECTED_VERSION,
			type: "hello",
			...hello,
		}),
	);
	return socket;
}

describe(PluginConnectionPool, () => {
	it("should select the connection that announces the expected protocol", async ({
		expect,
		onTestFinished,
	}) => {
		expect.assertions(1);

		const { pool, wss } = makePool(onTestFinished);
		const selecting = pool.selectAsync(REQUEST);
		connectPlugin(wss, { protocolVersion: EXPECTED_VERSION - 1 });
		const current = connectPlugin(wss);

		const selection = await afterAsync(REQUEST.connectTimeoutMs, selecting);

		expect(selection).toStrictEqual({
			kind: "selected",
			socket: fromPartial<WebSocket>(current),
		});
	});

	it("should select a connection that announced before the selection started", async ({
		expect,
		onTestFinished,
	}) => {
		// The probe's own connection: recorded on arrival, matched on request.
		expect.assertions(1);

		const { pool, wss } = makePool(onTestFinished);
		const current = connectPlugin(wss);

		const selection = await afterAsync(REQUEST.connectTimeoutMs, pool.selectAsync(REQUEST));

		expect(selection).toStrictEqual({
			kind: "selected",
			socket: fromPartial<WebSocket>(current),
		});
	});

	it("should report every connection when none announce the expected protocol", async ({
		expect,
		onTestFinished,
	}) => {
		expect.assertions(3);

		const { pool, wss } = makePool(onTestFinished);
		const selecting = pool.selectAsync(REQUEST);
		connectPlugin(wss, { protocolVersion: EXPECTED_VERSION - 1 });
		connectPlugin(wss, { protocolVersion: EXPECTED_VERSION - 2 });

		const selection = await afterAsync(REQUEST.connectTimeoutMs, selecting);

		expect(selection.kind).toBe("incompatible");

		assert(selection.kind === "incompatible");

		expect(selection.candidates).toHaveLength(2);
		expect(selection.candidates.map((entry) => entry.hello!.protocolVersion)).toStrictEqual([
			EXPECTED_VERSION - 1,
			EXPECTED_VERSION - 2,
		]);
	});

	it("should count a connection that never announces itself as incompatible", async ({
		expect,
		onTestFinished,
	}) => {
		// What every plugin predating the handshake looks like on the wire.
		expect.assertions(2);

		const { pool, wss } = makePool(onTestFinished);
		const selecting = pool.selectAsync(REQUEST);
		connectSilent(wss);

		const selection = await afterAsync(REQUEST.connectTimeoutMs, selecting);

		assert(selection.kind === "incompatible");

		expect(selection.candidates).toHaveLength(1);
		expect(selection.candidates[0]!.hello).toBeUndefined();
	});

	it("should report no connection when nothing connects at all", async ({
		expect,
		onTestFinished,
	}) => {
		expect.assertions(1);

		const { pool } = makePool(onTestFinished);

		const selection = await afterAsync(REQUEST.connectTimeoutMs, pool.selectAsync(REQUEST));

		expect(selection.kind).toBe("no-connection");
	});

	it("should answer on the grace window rather than wait out the connect timeout", async ({
		expect,
		onTestFinished,
	}) => {
		// The point of the grace window. `--backend studio` gives the connect
		// timeout the whole run budget (300s by default), so without this a
		// Studio full of stale plugins would hang rather than fail.
		expect.assertions(1);

		const { pool, wss } = makePool(onTestFinished);
		const selecting = pool.selectAsync({ ...REQUEST, connectTimeoutMs: 600_000, graceMs: 10 });
		connectPlugin(wss, { protocolVersion: EXPECTED_VERSION - 1 });

		const selection = await afterAsync(10, selecting);

		expect(selection.kind).toBe("incompatible");
	});

	it("should not restart the grace window when another stale plugin connects", async ({
		expect,
		onTestFinished,
	}) => {
		expect.assertions(2);

		const { pool, wss } = makePool(onTestFinished);
		const selecting = pool.selectAsync({ ...REQUEST, connectTimeoutMs: 600_000, graceMs: 10 });
		const settled = vi.fn<(selection: unknown) => void>();
		void selecting.then(settled);
		connectPlugin(wss, { protocolVersion: EXPECTED_VERSION - 1 });

		await vi.advanceTimersByTimeAsync(9);
		connectPlugin(wss, { protocolVersion: EXPECTED_VERSION - 2 });

		expect(vi.getTimerCount()).toBe(1);

		await vi.advanceTimersByTimeAsync(1);

		expect(settled).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ kind: "incompatible" }),
		);
	});

	it("should give a late plugin the whole grace window past the connect timeout", async ({
		expect,
		onTestFinished,
	}) => {
		// Auto-detection probes for 500ms against a 750ms grace, so the two
		// windows overlap. A stale socket arriving late in the probe must not
		// close selection while a compatible one still has window left.
		expect.assertions(1);

		const { pool, wss } = makePool(onTestFinished);
		const selecting = pool.selectAsync({ ...REQUEST, connectTimeoutMs: 20, graceMs: 200 });
		connectPlugin(wss, { protocolVersion: EXPECTED_VERSION - 1 });

		// Lands after the connect timeout would have fired, inside the grace.
		await waitAsync();
		const current = connectPlugin(wss);

		const selection = await afterAsync(REQUEST.connectTimeoutMs, selecting);

		expect(selection).toStrictEqual({
			kind: "selected",
			socket: fromPartial<WebSocket>(current),
		});
	});

	it("should keep waiting for a first connection rather than open the grace window early", async ({
		expect,
		onTestFinished,
	}) => {
		// The grace window is for deciding between connections. Opening it with
		// none would cut the connect timeout down to it, and a Studio that is
		// still starting would read as absent.
		expect.assertions(1);

		const { pool } = makePool(onTestFinished);
		const selecting = pool.selectAsync({ ...REQUEST, connectTimeoutMs: 600_000, graceMs: 10 });
		const pending = Symbol("pending");

		const raced = await Promise.race([selecting, waitAsync().then(() => pending)]);
		pool.abortSelection();
		await selecting;

		expect(raced).toBe(pending);
	});

	it("should open a fresh grace window for a second selection", async ({
		expect,
		onTestFinished,
	}) => {
		// A backend runs more than once against the same server. A spent grace
		// window left in place would make the second run wait out the connect
		// timeout instead: 300s on `--backend studio`.
		expect.assertions(2);

		const { pool, wss } = makePool(onTestFinished);
		const request = { ...REQUEST, connectTimeoutMs: 600_000, graceMs: 10 };
		connectPlugin(wss, { protocolVersion: EXPECTED_VERSION - 1 });

		const first = await afterAsync(10, pool.selectAsync(request));
		const second = await afterAsync(10, pool.selectAsync(request));

		expect(first.kind).toBe("incompatible");
		expect(second.kind).toBe("incompatible");
	});

	it("should ignore a frame that is not an announcement", async ({ expect, onTestFinished }) => {
		// Results and version_mismatch frames reach this listener too.
		expect.assertions(1);

		const { pool, wss } = makePool(onTestFinished);
		const selecting = pool.selectAsync(REQUEST);
		const socket = connectSilent(wss);
		send(
			socket,
			JSON.stringify({
				jestOutput: "{}",
				protocolVersion: EXPECTED_VERSION,
				type: "results",
			}),
		);
		socket.emit("message", Buffer.from("{not json"));

		const selection = await afterAsync(REQUEST.connectTimeoutMs, selecting);

		expect(selection.kind).toBe("incompatible");
	});

	it("should keep the first announcement when a socket announces twice", async ({
		expect,
		onTestFinished,
	}) => {
		// A second claim from an already-identified socket is not something to
		// act on: identity is established once, at open.
		expect.assertions(1);

		const { pool, wss } = makePool(onTestFinished);
		const selecting = pool.selectAsync(REQUEST);
		const socket = connectPlugin(wss, { protocolVersion: EXPECTED_VERSION - 1 });
		send(socket, JSON.stringify({ protocolVersion: EXPECTED_VERSION, type: "hello" }));

		const selection = await afterAsync(REQUEST.connectTimeoutMs, selecting);

		assert(selection.kind === "incompatible");

		expect(selection.candidates[0]!.hello!.protocolVersion).toBe(EXPECTED_VERSION - 1);
	});

	it("should drop a connection that closes before the selection settles", async ({
		expect,
		onTestFinished,
	}) => {
		expect.assertions(1);

		const { pool, wss } = makePool(onTestFinished);
		const selecting = pool.selectAsync(REQUEST);
		const socket = connectPlugin(wss, { protocolVersion: EXPECTED_VERSION - 1 });
		socket.emit("close");

		const selection = await afterAsync(REQUEST.connectTimeoutMs, selecting);

		expect(selection.kind).toBe("no-connection");
	});

	it("should keep what a socket announced when its connection is announced twice", async ({
		expect,
		onTestFinished,
	}) => {
		// Re-tracking would reset the candidate, losing the announcement made at
		// open. The plugin never sends a second one, so it would read as stale.
		expect.assertions(2);

		const { pool, wss } = makePool(onTestFinished);
		const selecting = pool.selectAsync(REQUEST);
		const socket = connectPlugin(wss, { protocolVersion: EXPECTED_VERSION - 1 });
		wss.emit("connection", socket);

		const selection = await afterAsync(REQUEST.connectTimeoutMs, selecting);

		assert(selection.kind === "incompatible");

		expect(selection.candidates).toHaveLength(1);
		expect(selection.candidates[0]!.hello!.protocolVersion).toBe(EXPECTED_VERSION - 1);
	});

	it("should end an in-flight selection on abort", async ({ expect, onTestFinished }) => {
		// The server failed to bind: no plugin will ever arrive, and the
		// connect timer would otherwise hold the event loop open.
		expect.assertions(1);

		const { pool, wss } = makePool(onTestFinished);
		const selecting = pool.selectAsync({ ...REQUEST, connectTimeoutMs: 600_000 });
		connectPlugin(wss, { protocolVersion: EXPECTED_VERSION - 1 });
		pool.abortSelection();

		const selection = await afterAsync(REQUEST.connectTimeoutMs, selecting);

		expect(selection.kind).toBe("no-connection");
	});

	it("should ignore an abort with no selection in flight", async ({ expect, onTestFinished }) => {
		expect.assertions(1);

		const { pool } = makePool(onTestFinished);
		pool.abortSelection();

		const selection = await afterAsync(
			10,
			pool.selectAsync({ ...REQUEST, connectTimeoutMs: 10 }),
		);

		expect(selection.kind).toBe("no-connection");
	});
});

describe(describePluginMismatch, () => {
	it("should name each connection by plugin name and release", ({ expect }) => {
		expect.assertions(1);

		const message = describePluginMismatch(
			[
				candidate({ pluginVersion: "0.3.18", protocolVersion: 5 }),
				candidate({
					pluginName: "OldRunner",
					pluginVersion: undefined,
					protocolVersion: 4,
				}),
				{ hello: undefined, socket: fromPartial<WebSocket>(new MockWebSocket()) },
			],
			EXPECTED_VERSION,
		);

		expect(message).toBe(
			"No compatible jest-roblox Studio plugin. This CLI speaks protocol v6, and the 3 " +
				"plugin connection(s) on this port report:\n" +
				"  - JestRobloxRunner 0.3.18 (protocol v5)\n" +
				"  - OldRunner (protocol v4, version not reported)\n" +
				"  - a plugin that sent no handshake (it predates the handshake entirely)\n" +
				`Install the JestRobloxRunner.rbxm shipped with jest-roblox ${packageJson.version}, ` +
				"and remove the other copies from your Studio plugins folder.",
		);
	});

	it("should fall back to an unnamed plugin when the announcement carries no name", ({
		expect,
	}) => {
		expect.assertions(1);

		const message = describePluginMismatch(
			[candidate({ pluginName: undefined, pluginVersion: "0.1.0", protocolVersion: 2 })],
			EXPECTED_VERSION,
		);

		expect(message).toContain("unnamed plugin 0.1.0 (protocol v2)");
	});
});

describe(closePluginServer, () => {
	it("should terminate every socket before closing the server", ({ expect }) => {
		// A live socket keeps the Node event loop running, so closing the
		// server alone hangs the CLI's exit.
		expect.assertions(2);

		const wss = new MockWebSocketServer({ port: 0 });
		const socket = new MockWebSocket();
		wss.emit("connection", socket);

		closePluginServer(fromPartial<WebSocketServer>(wss));

		expect(socket.terminate).toHaveBeenCalledExactlyOnceWith();
		expect(wss.close).toHaveBeenCalledExactlyOnceWith();
	});
});

function candidate(
	hello: Partial<NonNullable<PluginCandidate["hello"]>> & { protocolVersion: number },
): PluginCandidate {
	return {
		hello: { pluginName: "JestRobloxRunner", ...hello, type: "hello" },
		socket: fromPartial<WebSocket>(new MockWebSocket()),
	};
}
