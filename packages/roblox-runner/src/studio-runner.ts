import { type } from "arktype";
import type buffer from "node:buffer";
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";

import type {
	ExecuteScriptOptions,
	RemoteRunner,
	ScriptResult,
	UploadPlaceOptions,
	UploadPlaceResult,
} from "./types.ts";

const DEFAULT_TIMEOUT_MS = 300_000;

export interface StudioRunnerOptions {
	createServer?: (port: number) => WebSocketServer;
	port: number;
	timeout?: number;
}

const resultMessageSchema = type({
	outputs: "string[]",
	request_id: "string",
	type: "'results'",
});

type ResultMessage = typeof resultMessageSchema.infer;

export class StudioRunner implements RemoteRunner {
	private readonly createServerFn: (port: number) => WebSocketServer;
	private readonly port: number;
	private readonly timeout: number;

	constructor(options: StudioRunnerOptions) {
		this.port = options.port;
		this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
		this.createServerFn = options.createServer ?? ((port) => new WebSocketServer({ port }));
	}

	public async executeScript(options: ExecuteScriptOptions): Promise<ScriptResult> {
		const wss = this.createServerFn(this.port);

		try {
			const startTime = Date.now();
			const message = await this.waitForResult(wss, options.script);

			return {
				durationMs: Date.now() - startTime,
				outputs: message.outputs,
			};
		} finally {
			wss.close();
		}
	}

	public async uploadPlace(_options: UploadPlaceOptions): Promise<UploadPlaceResult> {
		return { cached: false, uploadMs: 0, versionNumber: 0 };
	}

	private async waitForResult(wss: WebSocketServer, script: string): Promise<ResultMessage> {
		const requestId = randomUUID();

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error("Timed out waiting for Studio plugin connection"));
			}, this.timeout);

			function attachSocket(ws: WebSocket): void {
				ws.send(
					JSON.stringify({
						action: "execute",
						request_id: requestId,
						script,
					}),
				);

				ws.on("message", (data: buffer.Buffer) => {
					const raw = JSON.parse(data.toString());
					const message = resultMessageSchema(raw);

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
