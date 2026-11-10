import { type } from "arktype";
import type buffer from "node:buffer";
import { randomUUID } from "node:crypto";
import type { WebSocket, WebSocketServer } from "ws";

import { NOOP_RUN_PROGRESS } from "../progress/run-progress.ts";
import { describeProjectCount } from "../progress/stages.ts";
import {
	DEFAULT_STUDIO_PORT,
	resultsFrameSchema,
	RUN_TESTS_ACTION,
	STUDIO_FRAME,
	STUDIO_PORT_ATTRIBUTE,
	STUDIO_PROTOCOL_VERSION,
	versionMismatchFrameSchema,
} from "../protocol/studio.ts";
import { decodeEnvelope } from "./envelope.ts";
import type { BackendOf, BackendResult } from "./interface.ts";
import {
	closePluginServer,
	describePluginMismatch,
	PluginConnectionPool,
} from "./plugin-connections.ts";
import {
	buildRunPayload,
	readPluginEntries,
	type RunPayload,
	type RunPayloadRequest,
	type StudioDispatch,
} from "./plugin-payload.ts";
import { nodeWebSocketServerFactory } from "./web-socket-server-factory.ts";
import type { WebSocketServerFactory } from "./web-socket-server-factory.ts";

interface StudioOptions {
	port: number;
	webSocketServerFactory?: undefined | WebSocketServerFactory;
}

const pluginMessageSchema = resultsFrameSchema
	.merge({ protocolVersion: `number == ${STUDIO_PROTOCOL_VERSION}` })
	.or(versionMismatchFrameSchema);

type PluginMessage = typeof pluginMessageSchema.infer;
type RunTestsMessage = RunPayload & {
	action: typeof RUN_TESTS_ACTION;
	protocolVersion: typeof STUDIO_PROTOCOL_VERSION;
	requestId: string;
};

interface PluginMessageWait {
	reject: (err: Error) => void;
	requestId: string;
	requestMessage: RunTestsMessage;
	resolve: (message: PluginMessage) => void;
	socket: WebSocket;
	timeout: number;
}

interface PluginSocketAttachment {
	reject: (err: Error) => void;
	requestId: string;
	requestMessage: RunTestsMessage;
	resolve: (message: PluginMessage) => void;
	socket: WebSocket;
	timer: NodeJS.Timeout;
}

/** Runs tests through the Studio plugin over a local WebSocket server. */
export class StudioBackend implements BackendOf<"studio", StudioDispatch> {
	private readonly port: number;
	private readonly webSocketServerFactory: WebSocketServerFactory;

	private pool: PluginConnectionPool | undefined;
	private wss: undefined | WebSocketServer;

	public readonly kind = "studio" as const;

	/**
	 * Stores the options; the server opens on the first run.
	 * @param options - Port and server factory.
	 */
	constructor(options: StudioOptions) {
		this.port = options.port;
		this.webSocketServerFactory = options.webSocketServerFactory ?? nodeWebSocketServerFactory;
	}

	/** Ends any in-flight plugin selection and closes the server. */
	public closeAsync(): void {
		const server = this.wss;
		// Abort first: closing the server leaves the pool's connect timer live.
		this.pool?.abortSelection();
		this.pool = undefined;
		this.wss = undefined;
		if (server === undefined) {
			return;
		}

		closePluginServer(server);
	}

	/**
	 * Opens the server if needed, dispatches the jobs to a compatible plugin, and waits for its results.
	 * @param options - Jobs and run options.
	 * @returns The per-job results and execution timing.
	 * @rejects {Error} When no compatible plugin connects, the plugin fails, or the run times out.
	 */
	public async runTestsAsync(options: StudioDispatch): Promise<BackendResult> {
		this.wss ??= this.webSocketServerFactory({ port: this.port });

		const progress = options.progress ?? NOOP_RUN_PROGRESS;
		const done = progress.begin("tests", describeProjectCount(options.jobs.length));
		const result = await this.executeViaPluginAsync(this.wss, options);
		done();
		return result;
	}

	private async executeViaPluginAsync(
		wss: WebSocketServer,
		{ bail, jobs, runSettings: { timeout }, vmParallel, workspace }: StudioDispatch,
	): Promise<BackendResult> {
		const requestId = randomUUID();
		const requestMessage = buildRunTestsMessage({
			bail,
			jobs,
			requestId,
			runBudgetMs: timeout,
			runtimeStubs: true,
			vmParallel,
			workspace,
		});

		const executionStart = Date.now();
		const message = await this.waitForResultAsync({
			connectTimeoutMs: timeout,
			deadline: executionStart + timeout,
			requestId,
			requestMessage,
			wss,
		});

		if (message.type === STUDIO_FRAME.versionMismatch) {
			throw new Error(
				`Studio plugin protocol version mismatch: plugin reported v${message.actualVersion.toString()}, CLI expected v${message.expectedVersion.toString()}. ` +
					"Update the jest-roblox Studio plugin to match this CLI version.",
			);
		}

		return {
			...readResults(message, jobs.length),
			timing: { executionMs: Date.now() - executionStart },
		};
	}

	private async selectSocketAsync(
		wss: WebSocketServer,
		connectTimeoutMs: number,
	): Promise<WebSocket> {
		// Before any await, so a plugin connecting this tick is recorded.
		this.pool ??= new PluginConnectionPool(wss);
		const selection = await this.pool.selectAsync({
			connectTimeoutMs,
			expectedVersion: STUDIO_PROTOCOL_VERSION,
		});

		if (selection.kind === "selected") {
			return selection.socket;
		}

		if (selection.kind === "incompatible") {
			throw new Error(describePluginMismatch(selection.candidates, STUDIO_PROTOCOL_VERSION));
		}

		throw new Error(
			`Timed out waiting for Studio plugin connection on port ${this.port.toString()}. The plugin dials port ${DEFAULT_STUDIO_PORT.toString()} unless ReplicatedStorage sets the ${STUDIO_PORT_ATTRIBUTE} attribute to this port.`,
		);
	}

	private async waitForResultAsync({
		connectTimeoutMs,
		deadline,
		requestId,
		requestMessage,
		wss,
	}: {
		readonly connectTimeoutMs: number;
		readonly deadline: number;
		readonly requestId: string;
		readonly requestMessage: RunTestsMessage;
		readonly wss: WebSocketServer;
	}): Promise<PluginMessage> {
		return new Promise((resolve, reject) => {
			wss.on("error", reject);

			this.selectSocketAsync(wss, connectTimeoutMs)
				.then((socket) => {
					awaitPluginMessage({
						reject,
						requestId,
						requestMessage,
						resolve,
						socket,
						timeout: deadline - Date.now(),
					});
				})
				.catch(reject);
		});
	}
}

function buildRunTestsMessage({
	requestId,
	...request
}: RunPayloadRequest & { requestId: string }): RunTestsMessage {
	return {
		action: RUN_TESTS_ACTION,
		protocolVersion: STUDIO_PROTOCOL_VERSION,
		requestId,
		...buildRunPayload(request),
	};
}

function readResults(
	message: Extract<PluginMessage, { type: "results" }>,
	jobCount: number,
): Pick<BackendResult, "bailed" | "rawResults"> {
	return readPluginEntries(decodeEnvelope(message.jestOutput), {
		backendName: "Studio backend",
		gameOutput: message.gameOutput,
		jobCount,
	});
}

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

function awaitPluginMessage({
	reject,
	requestId,
	requestMessage,
	resolve,
	socket,
	timeout,
}: PluginMessageWait): void {
	const timer = setTimeout(() => {
		reject(new Error("Timed out waiting for the Studio plugin to return results"));
	}, timeout);

	attachPluginSocket({ reject, requestId, requestMessage, resolve, socket, timer });
}
