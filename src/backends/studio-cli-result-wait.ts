import { type } from "arktype";
import type buffer from "node:buffer";
import { once } from "node:events";
import type { Except } from "type-fest";
import type { WebSocket, WebSocketServer } from "ws";

import {
	nilReturnFrameSchema,
	pluginReadyFrameSchema,
	type ResultsFrame,
	resultsFrameSchema,
	startedFrameSchema,
	STUDIO_PROTOCOL_VERSION,
} from "../protocol/studio.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { decodeEnvelope } from "./envelope.ts";
import type { BackendResult, ProjectJob } from "./interface.ts";
import { readPluginEntries } from "./plugin-payload.ts";
import {
	type NilReturnRelay,
	type ResultDeadline,
	startNilReturnRelay,
	startRunDeadlines,
} from "./studio-cli-deadlines.ts";
import type { StudioCliProcess } from "./studio-cli-types.ts";

const runFrameSchema = startedFrameSchema
	.or(resultsFrameSchema)
	.or(nilReturnFrameSchema)
	.or(pluginReadyFrameSchema);

type RunFrame = typeof runFrameSchema.infer;

interface RunFrameRoute {
	deadlines: { markStarted: () => void };
	nilRelay: Except<NilReturnRelay, "clear">;
	onResult: (message: ResultsFrame) => void;
	socket: WebSocket;
}

interface StudioCliResultWait extends ResultDeadline {
	child: StudioCliProcess;
	fileSystem: FileSystem;
	pluginKey: string | undefined;
	reject: (error: Error) => void;
	requestId: string;
	resolve: (message: ResultsFrame) => void;
	server: WebSocketServer;
}

type ResultChannel = Pick<StudioCliResultWait, "child" | "fileSystem" | "server">;

/**
 * The port the result server bound.
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
 * Resolve with the first `results` frame for this `requestId`.
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
}): Promise<ResultsFrame> {
	return new Promise<ResultsFrame>((resolve, reject) => {
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
 * Decode the run-mode result frame into the backend result.
 *
 * @param message - The result frame.
 * @param options - Execution time, jobs, and manually installed plugins.
 * @returns Results paired with the jobs, plus execution timing.
 * @throws Error when the plugin protocol version does not match the CLI.
 */
export function buildBackendResult(
	message: ResultsFrame,
	{
		executionMs,
		jobs,
		manualPlugins,
	}: { executionMs: number; jobs: Array<ProjectJob>; manualPlugins: ReadonlyArray<string> },
): BackendResult {
	// Decode first: a bootstrap failure envelope carries no protocolVersion.
	const decoded = decodeEnvelope(message.jestOutput);
	assertProtocolMatch(message, manualPlugins);

	return {
		...readPluginEntries(decoded, {
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

function assertProtocolMatch(
	{ pluginVersion, protocolVersion: actual }: ResultsFrame,
	manualPlugins: ReadonlyArray<string>,
): void {
	if (actual === STUDIO_PROTOCOL_VERSION) {
		return;
	}

	const reported = actual === undefined ? "no version" : `v${actual.toString()}`;
	const release = pluginVersion === undefined ? "" : ` from jest-roblox ${pluginVersion}`;
	const remedy =
		manualPlugins.length === 0
			? "Update the jest-roblox Studio plugin to match this CLI version."
			: `Remove or update these copies in the Studio plugins folder: ${manualPlugins.join(", ")}.`;
	throw new Error(
		"studio-cli: jest-roblox Studio plugin protocol version mismatch " +
			`(plugin${release} reported ${reported}, CLI expects v${STUDIO_PROTOCOL_VERSION.toString()}). ${remedy}`,
	);
}
