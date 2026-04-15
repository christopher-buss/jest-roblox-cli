import { type } from "arktype";
import type buffer from "node:buffer";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";

import { LuauScriptError, parseJestOutput } from "../reporter/parser.ts";
import { buildJestArgv, type JestArgv } from "../test-script.ts";
import type {
	Backend,
	BackendOptions,
	BackendResult,
	ProjectBackendResult,
	ProjectJob,
} from "./interface.ts";

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

const entrySchema = type({
	"elapsedMs?": "number",
	"gameOutput?": "string",
	"jestOutput": "string",
});

const envelopeSchema = type({ entries: entrySchema.array() });

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
	private wss?: WebSocketServer;

	public readonly kind = "studio" as const;

	constructor(options: StudioOptions) {
		this.port = options.port;
		this.timeout = options.timeout ?? DEFAULT_STUDIO_TIMEOUT;
		this.createServer = options.createServer ?? ((port) => new WebSocketServer({ port }));
		this.preConnected = options.preConnected;
	}

	public close(): void {
		const server = this.wss;
		this.wss = undefined;
		if (server === undefined) {
			return;
		}

		// ws.WebSocketServer.close() stops accepting new connections. Existing
		// sockets would linger, but since we only hold one CLI-scoped server
		// that's torn down at process end, that's fine (see C5).
		server.close();
	}

	public async runTests(options: BackendOptions): Promise<BackendResult> {
		const pre = this.preConnected;
		this.preConnected = undefined;

		this.wss ??= pre?.server ?? this.createServer(this.port);

		return this.executeViaPlugin(this.wss, options.jobs, pre?.socket);
	}

	private buildProjectResult(
		entry: typeof entrySchema.infer,
		job: ProjectJob,
		fallbackGameOutput: string | undefined,
	): ProjectBackendResult {
		const gameOutput = entry.gameOutput ?? fallbackGameOutput;

		let parsed;
		try {
			parsed = parseJestOutput(entry.jestOutput);
		} catch (err) {
			if (err instanceof LuauScriptError) {
				err.gameOutput = gameOutput;
			}

			throw err;
		}

		return {
			coverageData: parsed.coverageData,
			displayColor: job.displayColor,
			displayName: job.displayName,
			elapsedMs: entry.elapsedMs ?? 0,
			gameOutput,
			luauTiming: parsed.luauTiming,
			result: parsed.result,
			setupMs:
				parsed.setupSeconds !== undefined
					? Math.round(parsed.setupSeconds * 1000)
					: undefined,
			snapshotWrites: parsed.snapshotWrites,
		};
	}

	private async executeViaPlugin(
		wss: WebSocketServer,
		jobs: Array<ProjectJob>,
		existingSocket?: WebSocket,
	): Promise<BackendResult> {
		const requestId = randomUUID();
		const configs = jobs.map((job) => buildJestArgv(job));

		const executionStart = Date.now();
		const message = await this.waitForResult(wss, requestId, configs, existingSocket);
		const executionMs = Date.now() - executionStart;

		const entries = this.parseEnvelope(message.jestOutput);
		if (entries.length !== jobs.length) {
			throw new Error(
				`Studio backend returned ${entries.length.toString()} entries but request had ${jobs.length.toString()} jobs`,
			);
		}

		const results = entries.map((entry, index) => {
			// Safe: length equality asserted above.
			// eslint-disable-next-line ts/no-non-null-assertion -- length check
			const matched = jobs[index]!;
			return this.buildProjectResult(entry, matched, message.gameOutput);
		});

		return { results, timing: { executionMs } };
	}

	private parseEnvelope(jestOutput: string): Array<typeof entrySchema.infer> {
		// Legacy single-result payloads (error envelopes from the plugin before
		// run-mode returns entries) are re-wrapped as a length-1 entries array so
		// downstream parsing stays uniform.
		const raw: unknown = JSON.parse(jestOutput);
		const envelope = envelopeSchema(raw);
		if (envelope instanceof type.errors) {
			return [{ elapsedMs: 0, jestOutput }];
		}

		return envelope.entries;
	}

	private async waitForResult(
		wss: WebSocketServer,
		requestId: string,
		configs: Array<JestArgv>,
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
						config: { configs },
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
