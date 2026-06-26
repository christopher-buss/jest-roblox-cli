import { resolveCredentials } from "@isentinel/roblox-runner";
import type { RunnerCredentials } from "@isentinel/roblox-runner";

import process from "node:process";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";

import type { CliOptions, ResolvedConfig } from "../config/schema.ts";
import { LuauScriptError } from "../reporter/parser.ts";
import {
	type Backend,
	type BackendOptions,
	type BackendResult,
	isShardedParallel,
} from "./interface.ts";
import { createOpenCloudBackend } from "./open-cloud.ts";
import { createStudioCliBackend } from "./studio-cli.ts";
import { createStudioBackend } from "./studio.ts";

const ENV_PREFIX = "JEST_";

export interface ProbeResult {
	detected: false;
}

export interface ProbeDetected {
	detected: true;
	server: WebSocketServer;
	socket: WebSocket;
}

export class StudioWithFallback implements Backend {
	private readonly credentials: RunnerCredentials;
	private readonly studio: Backend;

	public readonly kind = "studio" as const;

	constructor(studio: Backend, credentials: RunnerCredentials) {
		this.studio = studio;
		this.credentials = credentials;
	}

	public async close(): Promise<void> {
		await this.studio.close?.();
	}

	public async runTests(options: BackendOptions): Promise<BackendResult> {
		try {
			return await this.studio.runTests(options);
		} catch (err) {
			if (isStudioBusyError(err)) {
				process.stderr.write("Studio busy, falling back to Open Cloud\n");
				return createOpenCloudBackend(this.credentials).runTests(options);
			}

			throw err;
		}
	}
}

export function isStudioBusyError(error: unknown): boolean {
	if (error instanceof LuauScriptError) {
		return /previous call to start play session/i.test(error.message);
	}

	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "EADDRINUSE"
	);
}

export async function probeStudioPlugin(
	port: number,
	timeoutMs: number,
	createServer: (port: number) => WebSocketServer = (wsPort) => {
		return new WebSocketServer({ port: wsPort });
	},
): Promise<ProbeDetected | ProbeResult> {
	return new Promise((resolve) => {
		const wss = createServer(port);

		const timer = setTimeout(() => {
			wss.close();
			resolve({ detected: false });
		}, timeoutMs);

		wss.on("connection", (ws: WebSocket) => {
			clearTimeout(timer);
			resolve({ detected: true, server: wss, socket: ws });
		});

		wss.on("error", () => {
			clearTimeout(timer);
			wss.close();
			resolve({ detected: false });
		});
	});
}

export async function resolveBackend(
	cli: CliOptions,
	config: ResolvedConfig,
	probe: (
		port: number,
		timeoutMs: number,
	) => Promise<ProbeDetected | ProbeResult> = probeStudioPlugin,
): Promise<Backend> {
	if (config.backend === "studio") {
		return createStudioBackend({ port: config.port, timeout: config.timeout });
	}

	if (config.backend === "studio-cli") {
		assertStudioCliSerial(config.parallel);
		return createStudioCliBackend({
			studioPath: config.studioPath,
			timeout: config.timeout,
		});
	}

	if (config.backend === "open-cloud") {
		return createOpenCloudBackend(buildCredentials(cli, config));
	}

	const credentials = tryBuildCredentials(cli, config);
	const probeResult = await probe(config.port, 500);

	if (probeResult.detected) {
		process.stderr.write("Backend: studio (plugin detected)\n");
		const studio = createStudioBackend({
			port: config.port,
			preConnected: { server: probeResult.server, socket: probeResult.socket },
			timeout: config.timeout,
		});
		if (credentials !== undefined) {
			return new StudioWithFallback(studio, credentials);
		}

		return studio;
	}

	if (credentials !== undefined) {
		process.stderr.write("Backend: open-cloud (no plugin, using Open Cloud)\n");
		return createOpenCloudBackend(credentials);
	}

	// User passed credential overrides via CLI but resolveCredentials still
	// failed — they intend open-cloud but missed a field. Surface the precise
	// resolver error rather than the generic "no backend" fallback.
	if (hasUserOverrides(cli)) {
		buildCredentials(cli, config);
	}

	throw new Error(
		"No backend available: Studio plugin not detected and no Open Cloud " +
			"credentials found. Set ROBLOX_OPEN_CLOUD_API_KEY, ROBLOX_UNIVERSE_ID, " +
			"and ROBLOX_PLACE_ID (or pass --apiKey, --universeId, --placeId; " +
			"or set universeId/placeId in jest.config.ts).",
	);
}

// studio-cli drives a single Studio instance, so it cannot shard. Reject a
// parallel request up front (the CLI otherwise drops `--parallel` for non-
// open-cloud backends, which would silently ignore the user's intent).
function assertStudioCliSerial(parallel: ResolvedConfig["parallel"]): void {
	if (isShardedParallel(parallel)) {
		throw new Error(
			"studio-cli backend is serial (one Studio instance); --parallel > 1 is not supported.",
		);
	}
}

function hasUserOverrides(cli: CliOptions): boolean {
	return cli.apiKey !== undefined || cli.universeId !== undefined || cli.placeId !== undefined;
}

function buildCredentials(cli: CliOptions, config: ResolvedConfig): RunnerCredentials {
	return resolveCredentials({
		defaults: { placeId: config.placeId, universeId: config.universeId },
		envPrefix: ENV_PREFIX,
		overrides: { apiKey: cli.apiKey, placeId: cli.placeId, universeId: cli.universeId },
	});
}

function tryBuildCredentials(
	cli: CliOptions,
	config: ResolvedConfig,
): RunnerCredentials | undefined {
	try {
		return buildCredentials(cli, config);
	} catch {
		return undefined;
	}
}
