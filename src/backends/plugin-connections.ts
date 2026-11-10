import { type } from "arktype";
import type buffer from "node:buffer";
import type { WebSocket, WebSocketServer } from "ws";

import { type HelloFrame, helloFrameSchema } from "../protocol/studio.ts";
import { VERSION } from "../version.ts";

// Must exceed `RECONNECT_DELAY` in `plugin/src/init.server.luau`.
const PLUGIN_HELLO_GRACE_MS = 750;

/** A connected plugin, and what it said about itself (nothing, if stale). */
export interface PluginCandidate {
	/** Announcement of the plugin, or `undefined` before or without one. */
	hello: HelloFrame | undefined;
	/** Socket of the connection. */
	socket: WebSocket;
}

/** Input to {@link PluginConnectionPool.selectAsync}. */
export interface PluginSelectionRequest {
	/** How long to wait for the first connection before giving up entirely. */
	connectTimeoutMs: number;
	/** Protocol version a connection must announce to be selected. */
	expectedVersion: number;
	/** How long to keep collecting announcements after the first connection. */
	graceMs?: number | undefined;
}

/** Outcome of a plugin selection. */
export type PluginSelection =
	| {
			/** A connection announced the expected protocol. */
			kind: "selected";
			/** Socket of the selected connection. */
			socket: WebSocket;
	  }
	| {
			/** Connections open when the window closed; none is compatible. */
			candidates: Array<PluginCandidate>;
			/** No connection announced the expected protocol. */
			kind: "incompatible";
	  }
	| {
			/** Nothing connected before the window closed. */
			kind: "no-connection";
	  };

/** Every plugin socket on one port, and which of them can serve this CLI. */
export class PluginConnectionPool {
	private readonly candidates = new Map<WebSocket, PluginCandidate>();

	private abort: (() => void) | undefined;
	private connectTimer: NodeJS.Timeout | undefined;
	private graceTimer: NodeJS.Timeout | undefined;
	private notify: (() => void) | undefined;

	/**
	 * Build the pool before anything connects: a socket announces only once.
	 * @param wss - Plugin server whose connections the pool tracks.
	 */
	constructor(wss: WebSocketServer) {
		wss.on("connection", (socket: WebSocket) => {
			this.track(socket);
		});
	}

	/** End an in-flight selection now, as though nothing had connected. */
	public abortSelection(): void {
		this.abort?.();
	}

	/**
	 * Resolve once a connection announces the expected protocol, or once the
	 * grace window closes over connections that cannot serve it.
	 * @param root0 - Selection request.
	 * @param root0.connectTimeoutMs - How long to wait for the first connection.
	 * @param root0.expectedVersion - Protocol version a connection must announce.
	 * @param root0.graceMs - How long to collect announcements after the first connection.
	 * @returns The selected socket, the incompatible connections, or no connection.
	 */
	public async selectAsync({
		connectTimeoutMs,
		expectedVersion,
		graceMs = PLUGIN_HELLO_GRACE_MS,
	}: PluginSelectionRequest): Promise<PluginSelection> {
		return new Promise((resolve) => {
			const settle = (selection: PluginSelection): void => {
				clearTimeout(this.connectTimer);
				clearTimeout(this.graceTimer);
				this.graceTimer = undefined;
				this.abort = undefined;
				this.notify = undefined;
				resolve(selection);
			};

			this.connectTimer = setTimeout(() => {
				settle(this.closedWindowOutcome());
			}, connectTimeoutMs);

			this.abort = () => {
				settle({ kind: "no-connection" });
			};

			this.notify = () => {
				this.checkSelection({ expectedVersion, graceMs, settle });
			};

			this.notify();
		});
	}

	private checkSelection({
		expectedVersion,
		graceMs,
		settle,
	}: {
		/** Protocol version a connection must announce. */
		expectedVersion: number;
		/** Length of the grace window. */
		graceMs: number;
		/** Ends the selection with an outcome. */
		settle: (selection: PluginSelection) => void;
	}): void {
		const matched = this.findMatch(expectedVersion);
		if (matched !== undefined) {
			settle({ kind: "selected", socket: matched });
			return;
		}

		if (this.graceTimer !== undefined || this.candidates.size === 0) {
			return;
		}

		clearTimeout(this.connectTimer);
		this.connectTimer = undefined;

		this.graceTimer = setTimeout(() => {
			settle(this.closedWindowOutcome());
		}, graceMs);
	}

	private closedWindowOutcome(): PluginSelection {
		const candidates = [...this.candidates.values()];
		return candidates.length > 0
			? { candidates, kind: "incompatible" }
			: { kind: "no-connection" };
	}

	private findMatch(expectedVersion: number): undefined | WebSocket {
		for (const candidate of this.candidates.values()) {
			if (candidate.hello?.protocolVersion === expectedVersion) {
				return candidate.socket;
			}
		}

		return undefined;
	}

	private record(socket: WebSocket, data: buffer.Buffer): void {
		const candidate = this.candidates.get(socket);
		if (candidate === undefined || candidate.hello !== undefined) {
			return;
		}

		const hello = helloFrameSchema(decodeFrame(data));
		if (hello instanceof type.errors) {
			return;
		}

		candidate.hello = hello;
		this.notify?.();
	}

	private track(socket: WebSocket): void {
		if (this.candidates.has(socket)) {
			return;
		}

		this.candidates.set(socket, { hello: undefined, socket });

		socket.on("message", (data: buffer.Buffer) => {
			this.record(socket, data);
		});

		socket.on("close", () => {
			this.candidates.delete(socket);
		});

		this.notify?.();
	}
}

/**
 * Close the plugin server and every socket on it.
 * @param wss - Plugin server to close.
 */
export function closePluginServer(wss: WebSocketServer): void {
	for (const client of wss.clients) {
		client.terminate();
	}

	wss.close();
}

/**
 * The error text for a Studio whose plugins cannot serve this CLI.
 * @param candidates - Connections that cannot serve the run.
 * @param expectedVersion - Protocol version this CLI speaks.
 * @returns The multi-line error message.
 */
export function describePluginMismatch(
	candidates: Array<PluginCandidate>,
	expectedVersion: number,
): string {
	const lines = candidates.map((candidate) => `  - ${describeCandidate(candidate)}`);

	return (
		"No compatible jest-roblox Studio plugin. This CLI speaks protocol " +
		`v${expectedVersion.toString()}, and the ${candidates.length.toString()} plugin ` +
		`connection(s) on this port report:\n${lines.join("\n")}\n` +
		`Install the JestRobloxRunner.rbxm shipped with jest-roblox ${VERSION}, ` +
		"and remove the other copies from your Studio plugins folder."
	);
}

function decodeFrame(data: buffer.Buffer): JSONValue | undefined {
	try {
		return JSON.parse(data.toString());
	} catch {
		return undefined;
	}
}

function describeCandidate({ hello }: PluginCandidate): string {
	if (hello === undefined) {
		return "a plugin that sent no handshake (it predates the handshake entirely)";
	}

	const name = hello.pluginName ?? "unnamed plugin";
	const protocol = `protocol v${hello.protocolVersion.toString()}`;
	if (hello.pluginVersion === undefined) {
		return `${name} (${protocol}, version not reported)`;
	}

	return `${name} ${hello.pluginVersion} (${protocol})`;
}
