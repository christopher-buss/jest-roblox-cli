import { type } from "arktype";
import type buffer from "node:buffer";
import { randomUUID } from "node:crypto";
import type { WebSocket, WebSocketServer } from "ws";

import { NOOP_RUN_PROGRESS } from "../progress/reporter.ts";
import { describeProjectCount } from "../progress/stages.ts";
import { decodeEnvelope } from "./envelope.ts";
import type { Backend, BackendOptions, BackendResult } from "./interface.ts";
import {
	closePluginServer,
	describePluginMismatch,
	PluginConnectionPool,
} from "./plugin-connections.ts";
import { buildRunPayload, pairPluginEntries, type RunPayloadRequest } from "./plugin-payload.ts";
import type { RunPayload } from "./plugin-payload.ts";
import { nodeWebSocketServerFactory } from "./web-socket-server-factory.ts";
import type { WebSocketServerFactory } from "./web-socket-server-factory.ts";

const DEFAULT_STUDIO_TIMEOUT = 300_000;

interface StudioOptions {
	port: number;
	timeout?: number | undefined;
	webSocketServerFactory?: undefined | WebSocketServerFactory;
}

/**
 * Plugin/CLI protocol version. Must match `PROTOCOL_VERSION` in
 * `plugin/src/init.server.luau`. Increment when the runtime contract changes —
 * v9 adds the workspace payload's `vmParallel` count, which a v8 plugin would
 * ignore and run sequentially; v8 adds the `pluginKey` a `studio-cli` run asks
 * for, which this backend never sends; v7 adds the `runnerTimeoutMs` argv the
 * runner enforces a project's budget from and strips before calling Jest, so a
 * v6 plugin handed one runs unbounded and passes the key through to Jest; v6
 * adds the `hello` announcement a plugin sends on connect, which is what lets
 * the CLI pick between several installed copies rather than dispatching to
 * whichever one connected first; v4 nests the fields the runner adds to Jest's
 * result under `runner` and renames the frame key `request_id` to `requestId`.
 * A connection that announces another version is never dispatched to, so
 * `version_mismatch` is now only reachable from a plugin whose announcement
 * and request handling disagree.
 */
export const STUDIO_PROTOCOL_VERSION = 9;

const pluginResultSchema = type({
	"gameOutput?": "string",
	"jestOutput": "string",
	// Derived rather than written out, so the bump above cannot leave the
	// schema accepting the version the CLI no longer speaks.
	"protocolVersion": `number == ${STUDIO_PROTOCOL_VERSION}`,
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

export class StudioBackend implements Backend {
	private readonly port: number;
	private readonly timeout: number;
	private readonly webSocketServerFactory: WebSocketServerFactory;

	private pool: PluginConnectionPool | undefined;
	private wss: undefined | WebSocketServer;

	public readonly kind = "studio" as const;
	public readonly placeInput = "none" as const;

	constructor(options: StudioOptions) {
		this.port = options.port;
		this.timeout = options.timeout ?? DEFAULT_STUDIO_TIMEOUT;
		this.webSocketServerFactory = options.webSocketServerFactory ?? nodeWebSocketServerFactory;
	}

	public closeAsync(): void {
		const server = this.wss;
		// Abort before dropping the reference: closing the server does not stop
		// the pool's connect timer, and on the default timeout that is a live
		// handle holding the process open for five minutes after a failure.
		this.pool?.abortSelection();
		this.pool = undefined;
		this.wss = undefined;
		if (server === undefined) {
			return;
		}

		closePluginServer(server);
	}

	public async runTestsAsync(options: BackendOptions): Promise<BackendResult> {
		this.wss ??= this.webSocketServerFactory({ port: this.port });

		// Announced here rather than in the executor, which wraps every backend
		// alike and so would open the stage around the upload too: only a
		// backend knows when its own dispatch window starts.
		const progress = options.progress ?? NOOP_RUN_PROGRESS;
		const done = progress.begin("tests", describeProjectCount(options.jobs.length));
		const result = await this.executeViaPluginAsync(this.wss, options);
		done();
		return result;
	}

	private async executeViaPluginAsync(
		wss: WebSocketServer,
		{ bail, jobs, vmParallel }: BackendOptions,
	): Promise<BackendResult> {
		const requestId = randomUUID();
		const requestMessage = buildRunTestsMessage({
			bail,
			jobs,
			requestId,
			runBudgetMs: this.timeout,
			vmParallel,
		});

		const executionStart = Date.now();
		const message = await this.waitForResultAsync(wss, requestMessage, requestId);

		// Unreachable against a plugin whose announcement matches what it
		// serves, since a connection announcing another protocol is never
		// dispatched to. Kept for the one that disagrees with itself.
		if (message.type === "version_mismatch") {
			throw new Error(
				`Studio plugin protocol version mismatch: plugin reported v${message.actualVersion.toString()}, CLI expected v${message.expectedVersion.toString()}. ` +
					"Update the jest-roblox Studio plugin to match this CLI version.",
			);
		}

		return {
			...pairResults(message, jobs.length),
			timing: { executionMs: Date.now() - executionStart },
		};
	}

	/**
	 * The socket to run on: the connection that announces this CLI's protocol
	 * version.
	 *
	 * Several installed plugin copies each open their own socket, so this is
	 * where "a Studio is listening" narrows to "this Studio can serve the run".
	 * Failing here means failing before the place is built, rather than after.
	 */
	private async selectSocketAsync(wss: WebSocketServer): Promise<WebSocket> {
		// Assigned before the first await of this chain, so a plugin connecting
		// into the same tick as the dispatch is still recorded.
		this.pool ??= new PluginConnectionPool(wss);
		const selection = await this.pool.selectAsync({
			connectTimeoutMs: this.timeout,
			expectedVersion: STUDIO_PROTOCOL_VERSION,
		});

		if (selection.kind === "selected") {
			return selection.socket;
		}

		if (selection.kind === "incompatible") {
			throw new Error(describePluginMismatch(selection.candidates, STUDIO_PROTOCOL_VERSION));
		}

		throw new Error("Timed out waiting for Studio plugin connection");
	}

	private async waitForResultAsync(
		wss: WebSocketServer,
		requestMessage: RunTestsMessage,
		requestId: string,
	): Promise<PluginMessage> {
		return new Promise((resolve, reject) => {
			// One error listener spans both halves of the wait — selecting a
			// compatible plugin, then the run itself. A bind failure surfaces
			// as EADDRINUSE, not as a timeout.
			wss.on("error", reject);

			this.selectSocketAsync(wss)
				.then((socket) => {
					awaitPluginMessage({
						reject,
						requestId,
						requestMessage,
						resolve,
						socket,
						timeout: this.timeout,
					});
				})
				.catch(reject);
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
	requestId,
	...request
}: RunPayloadRequest & { requestId: string }): RunTestsMessage {
	return {
		action: "run_tests",
		protocolVersion: STUDIO_PROTOCOL_VERSION,
		requestId,
		...buildRunPayload(request),
	};
}

/** The per-job entries a `results` frame carries, in request order. */
function pairResults(
	message: Extract<PluginMessage, { type: "results" }>,
	jobCount: number,
): Pick<BackendResult, "bailedJobIndices" | "rawResults"> {
	return pairPluginEntries(decodeEnvelope(message.jestOutput), {
		backendName: "Studio backend",
		gameOutput: message.gameOutput,
		jobCount,
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
 * Settle the run on whichever source fires first: the selected plugin's reply,
 * or the run timeout.
 *
 * Only the selected socket is dispatched to. Sending to every connection is
 * what let a second, stale plugin decide the run: it refuses the version the
 * instant it is asked, while the plugin actually running the suite answers
 * minutes later.
 */
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
