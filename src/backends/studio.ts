import { type } from "arktype";
import type buffer from "node:buffer";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";

import { buildJestArgv, type JestArgv } from "../test-script.ts";
import { parseEnvelope } from "./envelope.ts";
import type {
	Backend,
	BackendOptions,
	BackendResult,
	ProjectJob,
	RawBackendEntry,
} from "./interface.ts";

const DEFAULT_STUDIO_TIMEOUT = 300_000;

interface PreConnected {
	server: WebSocketServer;
	socket: WebSocket;
}

interface StudioOptions {
	createServer?: (port: number) => WebSocketServer;
	port: number;
	preConnected?: PreConnected;
	timeout?: number;
}

/**
 * Plugin/CLI protocol version. Must match `PROTOCOL_VERSION` in
 * `plugin/src/init.server.luau`. Increment when the runtime contract
 * changes (e.g. runtime-injection payload shape). Stale plugins return
 * `version_mismatch` explicitly OR (legacy plugins predating v2) return a
 * `results` envelope that fails schema validation because the
 * `protocolVersion` echo is missing — either way the CLI surfaces a clean
 * upgrade error instead of running with stale semantics.
 */
const STUDIO_PROTOCOL_VERSION = 2;

const pluginResultSchema = type({
	"gameOutput?": "string",
	"jestOutput": "string",
	"protocolVersion": "number == 2",
	"request_id": "string",
	"type": "'results'",
});

const pluginVersionMismatchSchema = type({
	actualVersion: "number",
	expectedVersion: "number",
	request_id: "string",
	type: "'version_mismatch'",
});

const pluginMessageSchema = pluginResultSchema.or(pluginVersionMismatchSchema);

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

	private async executeViaPlugin(
		wss: WebSocketServer,
		jobs: Array<ProjectJob>,
		existingSocket?: WebSocket,
	): Promise<BackendResult> {
		const requestId = randomUUID();
		const configs = jobs.map((job) => buildJestArgv(job));
		// Filtered injection targets per job. The plugin's Run Mode runner
		// uses this list (NOT `cfg.projects`) so mounts where Rojo already
		// syncs a user-authored `jest.config.luau` are not injected over.
		const runtimeStubMounts = jobs.map((job) => job.runtimeInjectionPaths ?? []);

		const executionStart = Date.now();
		const message = await this.waitForResult(
			wss,
			{ configs, requestId, runtimeStubMounts },
			existingSocket,
		);
		const executionMs = Date.now() - executionStart;

		if (message.type === "version_mismatch") {
			throw new Error(
				`Studio plugin protocol version mismatch: plugin reported v${message.actualVersion.toString()}, CLI expected v${message.expectedVersion.toString()}. ` +
					"Update the jest-roblox Studio plugin to match this CLI version.",
			);
		}

		const entries = parseEnvelope(message.jestOutput);
		if (entries.length !== jobs.length) {
			throw new Error(
				`Studio backend returned ${entries.length.toString()} entries but request had ${jobs.length.toString()} jobs`,
			);
		}

		const rawResults: Array<RawBackendEntry> = entries.map((entry) => {
			return { entry, fallbackGameOutput: message.gameOutput };
		});

		return { rawResults, timing: { executionMs } };
	}

	private async waitForResult(
		wss: WebSocketServer,
		request: {
			configs: Array<JestArgv>;
			requestId: string;
			runtimeStubMounts: Array<Array<string>>;
		},
		existingSocket?: WebSocket,
	): Promise<PluginMessage> {
		const { configs, requestId, runtimeStubMounts } = request;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error("Timed out waiting for Studio plugin connection"));
			}, this.timeout);

			function attachSocket(ws: WebSocket): void {
				ws.send(
					JSON.stringify({
						action: "run_tests",
						config: { configs },
						protocolVersion: STUDIO_PROTOCOL_VERSION,
						request_id: requestId,
						runtimeStubMounts,
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
