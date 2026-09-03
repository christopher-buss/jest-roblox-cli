import { type } from "arktype";
import type buffer from "node:buffer";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";

import { NOOP_RUN_PROGRESS } from "../progress/reporter.ts";
import { describeProjectCount } from "../progress/stages.ts";
import { decodeEnvelope } from "./envelope.ts";
import type { Backend, BackendOptions, BackendResult, RawBackendEntry } from "./interface.ts";
import {
	closePluginServer,
	describePluginMismatch,
	PluginConnectionPool,
} from "./plugin-connections.ts";
import { buildRunPayload, type RunPayloadRequest } from "./plugin-payload.ts";
import type { RunPayload } from "./plugin-payload.ts";

const DEFAULT_STUDIO_TIMEOUT = 300_000;

interface PreConnected {
	/** The probe's connection pool, carrying what each plugin announced. */
	pool: PluginConnectionPool;
	server: WebSocketServer;
	/** The socket the auto probe already selected by protocol version. */
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
 * changes — v7 adds the `runnerTimeoutMs` argv the runner enforces a project's
 * budget from and strips before calling Jest, so a v6 plugin handed one runs
 * unbounded and passes the key through to Jest; v6 adds the `hello`
 * announcement a plugin sends on connect, which is what lets the CLI pick
 * between several installed copies rather than dispatching to whichever one
 * connected first; v4 nests the fields the runner adds to Jest's result under
 * `runner` and renames the frame key `request_id` to `requestId`. A connection
 * that announces another version is never dispatched to, so `version_mismatch`
 * is now only reachable from a plugin whose announcement and request handling
 * disagree.
 */
export const STUDIO_PROTOCOL_VERSION = 7;

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
	private readonly createServer: (port: number) => WebSocketServer;
	private readonly port: number;
	private readonly timeout: number;

	private pool: PluginConnectionPool | undefined;
	private preConnected: PreConnected | undefined;
	private wss: undefined | WebSocketServer;

	public readonly kind = "studio" as const;

	constructor(options: StudioOptions) {
		this.port = options.port;
		this.timeout = options.timeout ?? DEFAULT_STUDIO_TIMEOUT;
		this.createServer = options.createServer ?? ((port) => new WebSocketServer({ port }));
		this.preConnected = options.preConnected;
		// Adopted rather than rebuilt: an announcement is sent once per socket,
		// so a pool built after the probe would see the probe's connections
		// without knowing what any of them are.
		this.pool = options.preConnected?.pool;
	}

	public closeAsync(): void {
		// Fall back to the pre-connected server: the auto probe can detect a
		// Studio (preConnected) and then close the backend via a zero-jobs flow
		// that never calls runTests, so `this.wss` is never assigned.
		const server = this.wss ?? this.preConnected?.server;
		// Abort before dropping the reference: closing the server does not stop
		// the pool's connect timer, and on the default timeout that is a live
		// handle holding the process open for five minutes after an explicit
		// failure or a fallback to Open Cloud.
		this.pool?.abortSelection();
		this.pool = undefined;
		this.wss = undefined;
		this.preConnected = undefined;
		if (server === undefined) {
			return;
		}

		closePluginServer(server);
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
			rawResults: buildRawResults(message, jobs.length),
			timing: { executionMs: Date.now() - executionStart },
		};
	}

	/**
	 * The socket to run on: the one the auto probe already selected, or the
	 * connection that announces this CLI's protocol version.
	 *
	 * Several installed plugin copies each open their own socket, so this is
	 * where "a Studio is listening" narrows to "this Studio can serve the run".
	 * Failing here means failing before the place is built, rather than after.
	 */
	private async selectSocketAsync(
		wss: WebSocketServer,
		existingSocket: undefined | WebSocket,
	): Promise<WebSocket> {
		if (existingSocket !== undefined) {
			return existingSocket;
		}

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
		existingSocket?: WebSocket,
	): Promise<PluginMessage> {
		return new Promise((resolve, reject) => {
			// One error listener spans both halves of the wait — selecting a
			// compatible plugin, then the run itself. A bind failure surfaces
			// as the EADDRINUSE `StudioWithFallback` reads, not as a timeout.
			wss.on("error", reject);

			this.selectSocketAsync(wss, existingSocket)
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
