import { type Type, type } from "arktype";
import type buffer from "node:buffer";
import { once } from "node:events";
import type { Except } from "type-fest";
import type { WebSocket, WebSocketServer } from "ws";

import type { FileSystem } from "../utils/file-system.ts";
import { decodeEnvelope } from "./envelope.ts";
import type { BackendResult, ProjectJob } from "./interface.ts";
import { pairPluginEntries } from "./plugin-payload.ts";
import { STUDIO_CLI_PROTOCOL_VERSION } from "./studio-cli-bootstrap.ts";
import {
	type NilReturnRelay,
	type ResultDeadline,
	startNilReturnRelay,
	startRunDeadlines,
} from "./studio-cli-deadlines.ts";
import type { StudioCliProcess } from "./studio-cli-types.ts";

const startedMessageSchema = type({
	requestId: "string",
	type: "'started'",
});

interface ResultMessage {
	gameOutput?: string;
	jestOutput: string;
	pluginKey?: string;
	pluginVersion?: string;
	protocolVersion?: number;
	requestId: string;
	type: "results";
}

/**
 * The result frame the bootstrap pushes back over the localhost WebSocket.
 * Same shape the plugin's `init.server.luau` sends the WebSocket `studio`
 * backend (`type: "results"` + `requestId` correlation), so the two result
 * channels stay wire-compatible. `protocolVersion` is optional here — a stale
 * run-mode runner omits it, and {@link assertProtocolMatch} turns that into a
 * clean "update the plugin" error rather than a schema rejection.
 */
const resultMessageSchema: Type<ResultMessage> = type({
	"gameOutput?": "string",
	"jestOutput": "string",
	"pluginKey?": "string",
	"pluginVersion?": "string",
	"protocolVersion?": "number",
	"requestId": "string",
	"type": "'results'",
});

const nilReturnMessageSchema = type({ requestId: "string", type: "'nilReturn'" });

const pluginReadyMessageSchema = type({ requestId: "string", type: "'pluginReady'" });

const runFrameSchema = startedMessageSchema
	.or(resultMessageSchema)
	.or(nilReturnMessageSchema)
	.or(pluginReadyMessageSchema);

type RunFrame = typeof runFrameSchema.infer;

interface RunFrameRoute {
	deadlines: { markStarted: () => void };
	nilRelay: Except<NilReturnRelay, "clear">;
	onResult: (message: ResultMessage) => void;
	socket: WebSocket;
}

interface StudioCliResultWait extends ResultDeadline {
	child: StudioCliProcess;
	fileSystem: FileSystem;
	pluginKey: string | undefined;
	reject: (error: Error) => void;
	requestId: string;
	resolve: (message: ResultMessage) => void;
	server: WebSocketServer;
}

/**
 * The one run whose result frame is awaited: the socket, and the child on it.
 */
type ResultChannel = Pick<StudioCliResultWait, "child" | "fileSystem" | "server">;

/**
 * The port the result server bound. A real `ws` server started on port 0 binds
 * asynchronously, so wait for `listening` and read the assigned port; the test
 * mock reports its port synchronously and is returned without waiting.
 *
 * @param server - The result WebSocket server.
 * @returns The bound port.
 * @rejects Error when the server binds no port.
 */
export async function serverPortAsync(server: WebSocketServer): Promise<number> {
	const address = server.address();
	if (address !== null && typeof address === "object") {
		return address.port;
	}

	await once(server, "listening");
	const bound = server.address();
	if (bound === null || typeof bound === "string") {
		throw new Error("studio-cli: result WebSocket server failed to bind a port.");
	}

	return bound.port;
}

/**
 * Resolve with the first `results` frame for this `requestId` — from the
 * bootstrap, or from the plugin after a nil return — or reject on timeout /
 * spawn failure. A stray frame never settles it with the wrong payload.
 *
 * @param options - Result channel, deadlines, plugin key, and request ID.
 * @returns The result frame for this run.
 * @rejects Error when a deadline expires, Studio fails, or the server fails.
 */
export async function waitForResultAsync({
	child,
	deadline,
	fileSystem,
	pluginKey,
	requestId,
	server,
}: ResultChannel & {
	readonly deadline: ResultDeadline;
	readonly pluginKey: string | undefined;
	readonly requestId: string;
}): Promise<ResultMessage> {
	return new Promise<ResultMessage>((resolve, reject) => {
		awaitStudioCliResult({
			...deadline,
			child,
			fileSystem,
			pluginKey,
			reject,
			requestId,
			resolve,
			server,
		});
	});
}

/**
 * Decode the run-mode result frame into the backend result. Decode the
 * envelope before the version check: when the bootstrap reached the plugin but
 * got nothing back (ExecuteRunModeAsync threw, or returned no result) it sends
 * a `{success:false, err}` envelope with no protocolVersion, and that error
 * must win over assertProtocolMatch so the real cause surfaces instead of a
 * misleading version mismatch.
 *
 * @param message - The result frame.
 * @param options - Execution time, jobs, and manually installed plugins.
 * @returns Results paired with the jobs, plus execution timing.
 * @throws Error when the plugin protocol version does not match the CLI.
 */
export function buildBackendResult(
	message: ResultMessage,
	{
		executionMs,
		jobs,
		manualPlugins,
	}: { executionMs: number; jobs: Array<ProjectJob>; manualPlugins: ReadonlyArray<string> },
): BackendResult {
	const decoded = decodeEnvelope(message.jestOutput);
	assertProtocolMatch(message, manualPlugins);

	return {
		...pairPluginEntries(decoded, {
			backendName: "studio-cli backend",
			gameOutput: message.gameOutput,
			jobCount: jobs.length,
		}),
		timing: { executionMs },
	};
}

function routeRunFrame(
	message: RunFrame,
	{ deadlines, nilRelay, onResult, socket }: RunFrameRoute,
): void {
	switch (message.type) {
		case "nilReturn": {
			deadlines.markStarted();
			nilRelay.onNilReturn();
			break;
		}
		case "pluginReady": {
			nilRelay.onPluginReady(socket);
			break;
		}
		case "results": {
			onResult(message);
			break;
		}
		case "started": {
			deadlines.markStarted();
			break;
		}
	}
}

function isOtherKeysResult(message: RunFrame, pluginKey: string | undefined): boolean {
	return (
		message.type === "results" &&
		pluginKey !== undefined &&
		message.pluginKey !== undefined &&
		message.pluginKey !== pluginKey
	);
}

/**
 * Forward this run's frames. Frames that aren't valid JSON, aren't a run
 * frame, belong to another run, or are a result from another key's plugin are
 * ignored (engine/plugin chatter).
 *
 * @param options - Frame route, plugin key, request ID, and server.
 */
function listenForRunFrames({
	pluginKey,
	requestId,
	server,
	...route
}: Except<RunFrameRoute, "socket"> & {
	pluginKey: string | undefined;
	requestId: string;
	server: WebSocketServer;
}): void {
	server.on("connection", (socket: WebSocket) => {
		socket.on("message", (data: buffer.Buffer) => {
			let raw: JSONValue;
			try {
				raw = JSON.parse(data.toString());
			} catch {
				return;
			}

			const message = runFrameSchema(raw);
			if (
				message instanceof type.errors ||
				message.requestId !== requestId ||
				isOtherKeysResult(message, pluginKey)
			) {
				return;
			}

			routeRunFrame(message, { ...route, socket });
		});
	});
}

/**
 * Wire every settle source onto the Promise's one-shot resolve/reject pair and
 * clear the deadlines before forwarding it.
 *
 * @param options - Result channel, deadlines, and the promise settlers.
 */
function awaitStudioCliResult({
	child,
	reject,
	requestId,
	resolve,
	server,
	...deadlineOptions
}: StudioCliResultWait): void {
	const deadlines = startRunDeadlines({ ...deadlineOptions, onExpired: bail });
	const nilRelay = startNilReturnRelay({ ...deadlineOptions, onExpired: bail, requestId });

	function settle(action: () => void): void {
		deadlines.clear();
		nilRelay.clear();
		action();
	}

	function bail(error: Error): void {
		settle(() => {
			reject(error);
		});
	}

	child.onError((error) => {
		bail(new Error(error.message, { cause: error }));
	});

	listenForRunFrames({
		deadlines,
		nilRelay,
		onResult: (result) => {
			settle(() => {
				resolve(result);
			});
		},
		pluginKey: deadlineOptions.pluginKey,
		requestId,
		server,
	});

	server.on("error", bail);
}

/**
 * Reject a run-mode result whose echoed `protocolVersion` doesn't match the
 * CLI's. A stale plugin (run-mode runner predating the handshake) omits the
 * echo entirely (`undefined`); a divergent plugin echoes a different number.
 * Either way the user must update the plugin. Mirrors the WebSocket backend's
 * `version_mismatch` path.
 *
 * @param message - The result frame with the echoed versions.
 * @param manualPlugins - Manually installed plugins to name in the error.
 * @throws Error when the echoed protocol version does not match the CLI.
 */
function assertProtocolMatch(
	{ pluginVersion, protocolVersion: actual }: ResultMessage,
	manualPlugins: ReadonlyArray<string>,
): void {
	if (actual === STUDIO_CLI_PROTOCOL_VERSION) {
		return;
	}

	const reported = actual === undefined ? "no version" : `v${actual.toString()}`;
	// Names the release the answering copy came from where it reported one:
	// several copies can be installed at once, and a protocol number alone
	// does not say which file to remove.
	const release = pluginVersion === undefined ? "" : ` from jest-roblox ${pluginVersion}`;
	// With a Managed Plugin installed, only a Manual Plugin can answer wrong.
	const remedy =
		manualPlugins.length === 0
			? "Update the jest-roblox Studio plugin to match this CLI version."
			: `Remove or update these copies in the Studio plugins folder: ${manualPlugins.join(", ")}.`;
	throw new Error(
		"studio-cli: jest-roblox Studio plugin protocol version mismatch " +
			`(plugin${release} reported ${reported}, CLI expects v${STUDIO_CLI_PROTOCOL_VERSION.toString()}). ${remedy}`,
	);
}
