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

interface PendingRequest {
	reject: (reason: Error) => void;
	requestId: string;
	resolve: (message: ResultMessage) => void;
	script: string;
	timer: ReturnType<typeof setTimeout>;
}

export class StudioRunner implements RemoteRunner {
	private readonly createServerFn: (port: number) => WebSocketServer;
	private readonly port: number;
	private readonly timeout: number;

	constructor(options: StudioRunnerOptions) {
		this.port = options.port;
		this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
		this.createServerFn = options.createServer ?? ((port) => new WebSocketServer({ port }));
	}

	public async executeScriptAsync(options: ExecuteScriptOptions): Promise<ScriptResult> {
		const wss = this.createServerFn(this.port);

		try {
			const startTime = Date.now();
			const message = await this.waitForResultAsync(wss, options.script);

			return {
				durationMs: Date.now() - startTime,
				outputs: message.outputs,
			};
		} finally {
			wss.close();
		}
	}

	/**
	 * Studio runs the place already open, so there is nothing to upload. The
	 * no-op await is load-bearing: `RemoteRunner` requires a promise return,
	 * and dropping `async` to satisfy `require-await` then trips
	 * `promise-function-async`.
	 */
	public async uploadPlaceAsync(_options: UploadPlaceOptions): Promise<UploadPlaceResult> {
		await Promise.resolve();
		return { uploadMs: 0, versionNumber: 0 };
	}

	private async waitForResultAsync(wss: WebSocketServer, script: string): Promise<ResultMessage> {
		const requestId = randomUUID();

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error("Timed out waiting for Studio plugin connection"));
			}, this.timeout);

			wss.on("connection", (ws: WebSocket) => {
				attachSocket(ws, { reject, requestId, resolve, script, timer });
			});

			wss.on("error", (err: Error) => {
				clearTimeout(timer);
				reject(err);
			});
		});
	}
}

function settleFromMessage(
	data: buffer.Buffer,
	{ reject, requestId, resolve, timer }: PendingRequest,
): void {
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
}

function attachSocket(ws: WebSocket, pending: PendingRequest): void {
	ws.send(
		JSON.stringify({
			action: "execute",
			request_id: pending.requestId,
			script: pending.script,
		}),
	);

	ws.on("message", (data: buffer.Buffer) => {
		settleFromMessage(data, pending);
	});

	ws.on("close", () => {
		clearTimeout(pending.timer);
		pending.reject(new Error("Studio plugin disconnected before sending results"));
	});

	ws.on("error", (err: Error) => {
		clearTimeout(pending.timer);
		pending.reject(err);
	});
}
