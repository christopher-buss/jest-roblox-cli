import { type } from "arktype";
import type buffer from "node:buffer";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";

import { parseEnvelope } from "./envelope.ts";
import {
	type Backend,
	type BackendOptions,
	type BackendResult,
	isWorkspaceRun,
	type ProjectJob,
	type RawBackendEntry,
} from "./interface.ts";
import { buildConfigEntries, buildWorkspaceEntries } from "./plugin-payload.ts";

const DEFAULT_STUDIO_TIMEOUT = 300_000;

interface PreConnected {
	server: WebSocketServer;
	socket: WebSocket;
}

interface StudioOptions {
	createServer?: ((port: number) => WebSocketServer) | undefined;
	port: number;
	preConnected?: PreConnected | undefined;
	timeout?: number | undefined;
}

/**
 * Plugin/CLI protocol version. Must match `PROTOCOL_VERSION` in
 * `plugin/src/init.server.luau`. Increment when the runtime contract
 * changes — v3 added the run-mode workspace dispatch + version echo. Stale
 * plugins return `version_mismatch` explicitly OR (older plugins) return a
 * `results` envelope that fails schema validation because the
 * `protocolVersion` echo is missing or a lower number — either way the CLI
 * surfaces a clean upgrade error instead of running with stale semantics.
 */
const STUDIO_PROTOCOL_VERSION = 3;

const pluginResultSchema = type({
	"gameOutput?": "string",
	"jestOutput": "string",
	"protocolVersion": "number == 3",
	"request_id": "string",
	"type": "'results'",
});

const pluginVersionMismatchSchema = type({
	actualVersion: "number",
	expectedVersion: "number",
	request_id: "string",
	type: "'version_mismatch'",
});

const pluginMessageSchema = pluginResultSchema.or(pluginVersionMismatchSchema);

type PluginMessage = typeof pluginMessageSchema.infer;

interface PluginMessageWait {
	existingSocket: undefined | WebSocket;
	reject: (err: Error) => void;
	requestId: string;
	requestMessage: object;
	resolve: (message: PluginMessage) => void;
	timeout: number;
	wss: WebSocketServer;
}

interface PluginSocketAttachment {
	reject: (err: Error) => void;
	requestId: string;
	requestMessage: object;
	resolve: (message: PluginMessage) => void;
	socket: WebSocket;
	timer: NodeJS.Timeout;
}

export class StudioBackend implements Backend {
	private readonly createServer: (port: number) => WebSocketServer;
	private readonly port: number;
	private readonly timeout: number;

	private preConnected: PreConnected | undefined;
	private wss: undefined | WebSocketServer;

	public readonly kind = "studio" as const;

	constructor(options: StudioOptions) {
		this.port = options.port;
		this.timeout = options.timeout ?? DEFAULT_STUDIO_TIMEOUT;
		this.createServer = options.createServer ?? ((port) => new WebSocketServer({ port }));
		this.preConnected = options.preConnected;
	}

	public close(): void {
		// Fall back to the pre-connected server: the auto probe can detect a
		// Studio (preConnected) and then close the backend via a zero-jobs flow
		// that never calls runTests, so `this.wss` is never assigned.
		const server = this.wss ?? this.preConnected?.server;
		this.wss = undefined;
		this.preConnected = undefined;
		if (server === undefined) {
			return;
		}

		// ws.WebSocketServer.close() stops accepting new connections but leaves
		// open sockets alive. A lingering plugin socket keeps the Node event
		// loop running, so the CLI's process.exitCode-based shutdown hangs after
		// a Studio run. Terminate the live sockets before closing the server.
		for (const client of server.clients) {
			client.terminate();
		}

		server.close();
	}

	public async runTests(options: BackendOptions): Promise<BackendResult> {
		const pre = this.preConnected;
		this.preConnected = undefined;

		this.wss ??= pre?.server ?? this.createServer(this.port);

		return this.executeViaPlugin(this.wss, options.jobs, pre?.socket);
	}

	private async executeViaPlugin(
		wss: WebSocketServer,
		jobs: Array<ProjectJob>,
		existingSocket?: WebSocket,
	): Promise<BackendResult> {
		const requestId = randomUUID();
		const requestMessage = buildRunTestsMessage(jobs, requestId);

		const executionStart = Date.now();
		const message = await this.waitForResult(wss, requestMessage, requestId, existingSocket);

		if (message.type === "version_mismatch") {
			throw new Error(
				`Studio plugin protocol version mismatch: plugin reported v${message.actualVersion.toString()}, CLI expected v${message.expectedVersion.toString()}. ` +
					"Update the jest-roblox Studio plugin to match this CLI version.",
			);
		}

		const executionMs = Date.now() - executionStart;
		const entries = parseEnvelope(message.jestOutput);
		if (entries.length !== jobs.length) {
			throw new Error(
				`Studio backend returned ${entries.length.toString()} entries but request had ${jobs.length.toString()} jobs`,
			);
		}

		const rawResults: Array<RawBackendEntry> = entries.map((entry) => {
			return { entry, fallbackGameOutput: message.gameOutput };
		});

		return { rawResults, timing: { executionMs } };
	}

	private async waitForResult(
		wss: WebSocketServer,
		requestMessage: object,
		requestId: string,
		existingSocket?: WebSocket,
	): Promise<PluginMessage> {
		return new Promise((resolve, reject) => {
			awaitPluginMessage({
				existingSocket,
				reject,
				requestId,
				requestMessage,
				resolve,
				timeout: this.timeout,
				wss,
			});
		});
	}
}

export function createStudioBackend(options: StudioOptions): StudioBackend {
	return new StudioBackend(options);
}

/**
 * Send the `run_tests` request over `socket` and settle the run on the
 * plugin's reply — resolving the correlated `results`/`version_mismatch`
 * message, or rejecting on a message that fails validation, a disconnect, or a
 * socket error.
 */
function attachPluginSocket({
	reject,
	requestId,
	requestMessage,
	resolve,
	socket,
	timer,
}: PluginSocketAttachment): void {
	socket.send(String(JSON.stringify(requestMessage)));

	socket.on("message", (data: buffer.Buffer) => {
		const raw = JSON.parse(data.toString());
		const message = pluginMessageSchema(raw);

		if (message instanceof type.errors) {
			clearTimeout(timer);
			reject(new Error(`Invalid plugin message: ${message.summary}`));
			return;
		}

		if (message.request_id === requestId) {
			clearTimeout(timer);
			resolve(message);
		}
	});

	socket.on("close", () => {
		clearTimeout(timer);
		reject(new Error("Studio plugin disconnected before sending results"));
	});

	socket.on("error", (err: Error) => {
		clearTimeout(timer);
		reject(err);
	});
}

/**
 * Settle the run on whichever source fires first: the connection timeout, a
 * plugin message on an already-connected socket (the auto probe hands one
 * over), a message on a socket that connects later, or a server error.
 */
function awaitPluginMessage({
	existingSocket,
	reject,
	requestId,
	requestMessage,
	resolve,
	timeout,
	wss,
}: PluginMessageWait): void {
	const timer = setTimeout(() => {
		reject(new Error("Timed out waiting for Studio plugin connection"));
	}, timeout);

	const attachment = { reject, requestId, requestMessage, resolve, timer };

	if (existingSocket) {
		attachPluginSocket({ ...attachment, socket: existingSocket });
	}

	wss.on("connection", (ws: WebSocket) => {
		attachPluginSocket({ ...attachment, socket: ws });
	});

	wss.on("error", (err: Error) => {
		clearTimeout(timer);
		reject(err);
	});
}

/**
 * Build the `run_tests` WebSocket message the plugin forwards into
 * `ExecuteRunModeAsync`. A workspace run (jobs carry `pkg`) sends
 * `workspace.entries` — the staged-materializer shape the plugin's run-mode
 * runner dispatches on. A single-/multi-project run sends `config.configs`
 * plus the filtered `runtimeStubMounts` (parallel to `configs`) so the runner
 * injects `jest.config` only where Rojo doesn't already sync a user-authored
 * one.
 */
function buildRunTestsMessage(jobs: Array<ProjectJob>, requestId: string): object {
	const base = {
		action: "run_tests",
		protocolVersion: STUDIO_PROTOCOL_VERSION,
		request_id: requestId,
	};

	if (isWorkspaceRun(jobs)) {
		return { ...base, workspace: { entries: buildWorkspaceEntries(jobs) } };
	}

	const { configs, runtimeStubMounts } = buildConfigEntries(jobs);
	return { ...base, config: { configs }, runtimeStubMounts };
}
