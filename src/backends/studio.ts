import { type } from "arktype";
import type buffer from "node:buffer";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";

import { NOOP_RUN_PROGRESS } from "../progress/reporter.ts";
import { describeProjectCount } from "../progress/stages.ts";
import { decodeEnvelope } from "./envelope.ts";
import type { Backend, BackendOptions, BackendResult, RawBackendEntry } from "./interface.ts";
import { buildRunPayload, type RunPayloadRequest } from "./plugin-payload.ts";
import type { RunPayload } from "./plugin-payload.ts";

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
 * changes — v4 nests the fields the runner adds to Jest's result under
 * `runner` and renames the frame key `request_id` to `requestId`. Stale
 * plugins return `version_mismatch` explicitly OR (older plugins) return a
 * `results` envelope that fails schema validation because the
 * `protocolVersion` echo is missing or a lower number — either way the CLI
 * surfaces a clean upgrade error instead of running with stale semantics.
 */
const STUDIO_PROTOCOL_VERSION = 5;

const pluginResultSchema = type({
	"gameOutput?": "string",
	"jestOutput": "string",
	"protocolVersion": "number == 5",
	"requestId": "string",
	"type": "'results'",
});

const pluginVersionMismatchSchema = type({
	actualVersion: "number",
	expectedVersion: "number",
	requestId: "string",
	type: "'version_mismatch'",
});

const pluginMessageSchema = pluginResultSchema.or(pluginVersionMismatchSchema);

type PluginMessage = typeof pluginMessageSchema.infer;
type RunTestsMessage = RunPayload & {
	action: "run_tests";
	protocolVersion: typeof STUDIO_PROTOCOL_VERSION;
	requestId: string;
};

interface PluginMessageWait {
	existingSocket: undefined | WebSocket;
	reject: (err: Error) => void;
	requestId: string;
	requestMessage: RunTestsMessage;
	resolve: (message: PluginMessage) => void;
	timeout: number;
	wss: WebSocketServer;
}

interface PluginSocketAttachment {
	reject: (err: Error) => void;
	requestId: string;
	requestMessage: RunTestsMessage;
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

	public closeAsync(): void {
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

	public async runTestsAsync(options: BackendOptions): Promise<BackendResult> {
		const pre = this.preConnected;
		this.preConnected = undefined;

		this.wss ??= pre?.server ?? this.createServer(this.port);

		// Announced here rather than in the executor, which wraps every backend
		// alike and so would open the stage around the upload too: only a
		// backend knows when its own dispatch window starts.
		const progress = options.progress ?? NOOP_RUN_PROGRESS;
		const done = progress.begin("tests", describeProjectCount(options.jobs.length));
		const result = await this.executeViaPluginAsync(this.wss, options, pre?.socket);
		done();
		return result;
	}

	private async executeViaPluginAsync(
		wss: WebSocketServer,
		{ jobs, vmParallel }: BackendOptions,
		existingSocket?: WebSocket,
	): Promise<BackendResult> {
		const requestId = randomUUID();
		const requestMessage = buildRunTestsMessage({
			jobs,
			requestId,
			runBudgetMs: this.timeout,
			vmParallel,
		});

		const executionStart = Date.now();
		const message = await this.waitForResultAsync(
			wss,
			requestMessage,
			requestId,
			existingSocket,
		);

		if (message.type === "version_mismatch") {
			throw new Error(
				`Studio plugin protocol version mismatch: plugin reported v${message.actualVersion.toString()}, CLI expected v${message.expectedVersion.toString()}. ` +
					"Update the jest-roblox Studio plugin to match this CLI version.",
			);
		}

		return {
			rawResults: buildRawResults(message, jobs.length),
			timing: { executionMs: Date.now() - executionStart },
		};
	}

	private async waitForResultAsync(
		wss: WebSocketServer,
		requestMessage: RunTestsMessage,
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
 * Build the `run_tests` WebSocket message the plugin forwards into
 * `ExecuteRunModeAsync`. A workspace run (jobs carry `pkg`) sends
 * `workspace.entries` — the staged-materializer shape the plugin's run-mode
 * runner dispatches on. A single-/multi-project run sends `config.configs`
 * plus the filtered `runtimeStubMounts` (parallel to `configs`) so the runner
 * injects `jest.config` only where Rojo doesn't already sync a user-authored
 * one.
 */
function buildRunTestsMessage({
	jobs,
	requestId,
	runBudgetMs,
	vmParallel,
}: RunPayloadRequest & { requestId: string }): RunTestsMessage {
	return {
		action: "run_tests",
		protocolVersion: STUDIO_PROTOCOL_VERSION,
		requestId,
		...buildRunPayload({ jobs, runBudgetMs, vmParallel }),
	};
}

/**
 * The per-job raw entries a `results` frame carries, in request order.
 *
 * `gameOutputScope` rides along from the envelope: it is the runner's report of
 * whether the run's game output was captured once for the batch (an in-session
 * parallel run) or per project.
 */
function buildRawResults(
	message: Extract<PluginMessage, { type: "results" }>,
	jobCount: number,
): Array<RawBackendEntry> {
	const { entries, gameOutputScope } = decodeEnvelope(message.jestOutput);
	if (entries.length !== jobCount) {
		throw new Error(
			`Studio backend returned ${entries.length.toString()} entries but request had ${jobCount.toString()} jobs`,
		);
	}

	return entries.map((entry) => {
		return { entry, fallbackGameOutput: message.gameOutput, gameOutputScope };
	});
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
	socket.send(JSON.stringify(requestMessage));

	socket.on("message", (data: buffer.Buffer) => {
		const raw = JSON.parse(data.toString());
		const message = pluginMessageSchema(raw);

		if (message instanceof type.errors) {
			clearTimeout(timer);
			reject(new Error(`Invalid plugin message: ${message.summary}`));
			return;
		}

		if (message.requestId === requestId) {
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
