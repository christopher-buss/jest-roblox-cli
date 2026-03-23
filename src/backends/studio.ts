import { type } from "arktype";
import type buffer from "node:buffer";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";

import { LuauScriptError, parseJestOutput } from "../reporter/parser.ts";
import { buildJestArgv } from "../test-script.ts";
import type { Backend, BackendOptions, BackendResult } from "./interface.ts";

const DEFAULT_STUDIO_TIMEOUT = 300_000;

export interface PreConnected {
	server: WebSocketServer;
	socket: WebSocket;
}

export interface StudioOptions {
	createServer?: (port: number) => WebSocketServer;
	port: number;
	preConnected?: PreConnected;
	timeout?: number;
}

const pluginMessageSchema = type({
	"gameOutput?": "string",
	"jestOutput": "string",
	"request_id": "string",
	"type": "'results'",
});

type PluginMessage = typeof pluginMessageSchema.infer;

export class StudioBackend implements Backend {
	private readonly createServer: (port: number) => WebSocketServer;
	private readonly port: number;
	private readonly timeout: number;

	private preConnected?: PreConnected;

	constructor(options: StudioOptions) {
		this.port = options.port;
		this.timeout = options.timeout ?? DEFAULT_STUDIO_TIMEOUT;
		this.createServer = options.createServer ?? ((port) => new WebSocketServer({ port }));
		this.preConnected = options.preConnected;
	}

	public async runTests(options: BackendOptions): Promise<BackendResult> {
		const pre = this.preConnected;
		this.preConnected = undefined;

		const wss = pre?.server ?? this.createServer(this.port);

		try {
			return await this.executeViaPlugin(wss, options, pre?.socket);
		} finally {
			wss.close();
		}
	}

	private async executeViaPlugin(
		wss: WebSocketServer,
		options: BackendOptions,
		existingSocket?: WebSocket,
	): Promise<BackendResult> {
		const requestId = randomUUID();
		const config = buildJestArgv(options);

		const executionStart = Date.now();
		const message = await this.waitForResult(wss, requestId, config, existingSocket);
		const executionMs = Date.now() - executionStart;

		let parsed;
		try {
			parsed = parseJestOutput(message.jestOutput);
		} catch (err) {
			if (err instanceof LuauScriptError) {
				err.gameOutput = message.gameOutput;
			}

			throw err;
		}

		return {
			coverageData: parsed.coverageData,
			gameOutput: message.gameOutput,
			luauTiming: parsed.luauTiming,
			result: parsed.result,
			snapshotWrites: parsed.snapshotWrites,
			timing: { executionMs },
		};
	}

	private async waitForResult(
		wss: WebSocketServer,
		requestId: string,
		config: unknown,
		existingSocket?: WebSocket,
	): Promise<PluginMessage> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error("Timed out waiting for Studio plugin connection"));
			}, this.timeout);

			function attachSocket(ws: WebSocket): void {
				ws.send(
					JSON.stringify({
						action: "run_tests",
						config,
						request_id: requestId,
					}),
				);

				ws.on("message", (data: buffer.Buffer) => {
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

				ws.on("close", () => {
					clearTimeout(timer);
					reject(new Error("Studio plugin disconnected before sending results"));
				});

				ws.on("error", (err: Error) => {
					clearTimeout(timer);
					reject(err);
				});
			}

			if (existingSocket) {
				attachSocket(existingSocket);
			}

			wss.on("connection", (ws: WebSocket) => {
				attachSocket(ws);
			});

			wss.on("error", (err: Error) => {
				clearTimeout(timer);
				reject(err);
			});
		});
	}
}

export function createStudioBackend(options: StudioOptions): StudioBackend {
	return new StudioBackend(options);
}
