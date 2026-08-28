import { type } from "arktype";
import type buffer from "node:buffer";
import type { WebSocket, WebSocketServer } from "ws";

import packageJson from "../../package.json" with { type: "json" };

/**
 * How long to keep collecting announcements once the first plugin connects.
 *
 * Every installed copy of the plugin dials the same port, and a copy that is
 * not already connected reconnects on a 0.1s cadence (`RECONNECT_DELAY` in
 * `plugin/src/init.server.luau`), so this window is wide enough to hear from
 * all of them. It is only ever waited out in full when nothing matches: a
 * matching announcement settles the selection the instant it lands.
 */
const PLUGIN_HELLO_GRACE_MS = 750;

/**
 * The unsolicited frame a plugin sends as soon as its socket opens.
 *
 * `protocolVersion` decides whether a connection can serve the run.
 * `pluginVersion` and `pluginName` are diagnostic only — they exist so a user
 * running several installed copies is told which one to remove, and are
 * optional because a plugin built without the version stamp still reports a
 * usable protocol.
 */
export interface PluginHello {
	pluginName?: string | undefined;
	pluginVersion?: string | undefined;
	protocolVersion: number;
	type: "hello";
}

const pluginHelloSchema = type({
	"pluginName?": "string",
	"pluginVersion?": "string",
	"protocolVersion": "number",
	"type": "'hello'",
});

/** A connected plugin, and what it said about itself (nothing, if stale). */
export interface PluginCandidate {
	hello: PluginHello | undefined;
	socket: WebSocket;
}

export interface PluginSelectionRequest {
	/** How long to wait for the first connection before giving up entirely. */
	connectTimeoutMs: number;
	expectedVersion: number;
	graceMs?: number | undefined;
}

export type PluginSelection =
	| { candidates: Array<PluginCandidate>; kind: "incompatible" }
	| { kind: "no-connection" }
	| { kind: "selected"; socket: WebSocket };

/**
 * Every plugin socket on one port, and which of them can serve this CLI.
 *
 * A Studio with several `JestRobloxRunner` copies installed opens one socket
 * per copy, so "the plugin" is a selection rather than a given: the pool
 * records each connection's announcement and hands back the one whose protocol
 * matches. Dispatching to an unselected socket is what used to let a stale copy
 * lose the run for a Studio that also had a working one — a stale copy refuses
 * instantly while the working copy is still running the suite, so its refusal
 * always won the race.
 */
export class PluginConnectionPool {
	private readonly candidates = new Map<WebSocket, PluginCandidate>();

	private abort: (() => void) | undefined;
	private connectTimer: NodeJS.Timeout | undefined;
	private graceTimer: NodeJS.Timeout | undefined;
	private notify: (() => void) | undefined;

	/**
	 * Build the pool before anything can connect, and keep it for the life of
	 * the server. An announcement arrives once per socket, at open: a pool
	 * built over a server that already has clients would see those clients but
	 * never learn what they are, and read a working plugin as a stale one.
	 */
	constructor(wss: WebSocketServer) {
		wss.on("connection", (socket: WebSocket) => {
			this.track(socket);
		});
	}

	/**
	 * End an in-flight selection now, as though nothing had connected.
	 *
	 * For the caller that learns from elsewhere that the wait is pointless —
	 * a server that failed to bind has no plugins to hear from — and would
	 * otherwise leave the connect timer holding the event loop open.
	 */
	public abortSelection(): void {
		this.abort?.();
	}

	/**
	 * Resolve once a connection announces the expected protocol, or once the
	 * grace window closes over connections that cannot serve it.
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
				// Cleared, not just stopped: a backend runs more than once
				// against the same server, and the next selection opens its own
				// grace window rather than inheriting a spent one.
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

	/**
	 * Settle on a connection that fits, or open the grace window over the ones
	 * that do not.
	 *
	 * The connect timeout covers "is anything there at all"; once something is,
	 * the grace window covers "does any of it fit", and it opens once rather
	 * than restarting on each connection.
	 */
	private checkSelection({
		expectedVersion,
		graceMs,
		settle,
	}: {
		expectedVersion: number;
		graceMs: number;
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

		// The two windows are sequential, not concurrent. Auto-detection probes
		// for 500ms against a 750ms grace, so leaving the connect timer armed
		// would let a stale socket arriving late in the probe close selection
		// before a compatible one had its promised window to announce in.
		clearTimeout(this.connectTimer);
		this.connectTimer = undefined;

		this.graceTimer = setTimeout(() => {
			settle(this.closedWindowOutcome());
		}, graceMs);
	}

	/**
	 * What a closed window means: the connections still open, or that there are
	 * none — a socket that connected and dropped again leaves nothing to name
	 * and nothing to run on.
	 */
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
		// The first announcement wins: a plugin identifies itself once, and a
		// later frame claiming a different version is not something to act on.
		if (candidate === undefined || candidate.hello !== undefined) {
			return;
		}

		const hello = pluginHelloSchema(decodeFrame(data));
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
 *
 * `WebSocketServer.close()` stops new connections but leaves open sockets
 * alive, and a live plugin socket keeps the Node event loop running — which
 * hangs the CLI's `process.exitCode`-based shutdown. Every path that abandons
 * the server has to terminate its clients first.
 */
export function closePluginServer(wss: WebSocketServer): void {
	for (const client of wss.clients) {
		client.terminate();
	}

	wss.close();
}

/**
 * The error text for a Studio whose plugins cannot serve this CLI: what the CLI
 * needs, what each connection reported, and what to do about it.
 *
 * Names every connection rather than just the first, because the case this
 * exists for is several installed copies — knowing only that "a plugin is
 * stale" does not say which file to delete.
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
		`Install the JestRobloxRunner.rbxm shipped with jest-roblox ${packageJson.version}, ` +
		"and remove the other copies from your Studio plugins folder."
	);
}

/**
 * A frame's JSON, or nothing when it is not JSON at all.
 *
 * Every frame on a plugin socket reaches the pool's listener — results,
 * version_mismatch, and whatever a plugin from a future protocol sends — so an
 * unreadable one is ordinary traffic rather than a fault.
 */
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
