import process from "node:process";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";

import type { ResolvedConfig } from "../config/schema.ts";
import { LuauScriptError } from "../reporter/parser.ts";
import type { Backend, BackendOptions, BackendResult } from "./interface.ts";
import { createOpenCloudBackend } from "./open-cloud.ts";
import { createStudioBackend } from "./studio.ts";

export interface ProbeResult {
	detected: false;
}

export interface ProbeDetected {
	detected: true;
	server: WebSocketServer;
	socket: WebSocket;
}

export class StudioWithFallback implements Backend {
	private readonly studio: Backend;

	constructor(studio: Backend) {
		this.studio = studio;
	}

	public async runTests(options: BackendOptions): Promise<BackendResult> {
		try {
			return await this.studio.runTests(options);
		} catch (err) {
			if (isStudioBusyError(err)) {
				process.stderr.write("Studio busy, falling back to Open Cloud\n");
				return createOpenCloudBackend().runTests(options);
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
	config: ResolvedConfig,
	probe: (
		port: number,
		timeoutMs: number,
	) => Promise<ProbeDetected | ProbeResult> = probeStudioPlugin,
): Promise<Backend> {
	if (config.backend === "studio") {
		return createStudioBackend({ port: config.port, timeout: config.timeout });
	}

	if (config.backend === "open-cloud") {
		return createOpenCloudBackend();
	}

	const probeResult = await probe(config.port, 500);

	if (probeResult.detected) {
		process.stderr.write("Backend: studio (plugin detected)\n");
		const studio = createStudioBackend({
			port: config.port,
			preConnected: { server: probeResult.server, socket: probeResult.socket },
			timeout: config.timeout,
		});
		if (hasOpenCloudCredentials()) {
			return new StudioWithFallback(studio);
		}

		return studio;
	}

	if (hasOpenCloudCredentials()) {
		process.stderr.write("Backend: open-cloud (no plugin, using Open Cloud)\n");
		return createOpenCloudBackend();
	}

	throw new Error(
		"No backend available: Studio plugin not detected and Open Cloud env vars (ROBLOX_OPEN_CLOUD_API_KEY, ROBLOX_UNIVERSE_ID, ROBLOX_PLACE_ID) are missing",
	);
}

function hasOpenCloudCredentials(): boolean {
	return (
		process.env["ROBLOX_OPEN_CLOUD_API_KEY"] !== undefined &&
		process.env["ROBLOX_UNIVERSE_ID"] !== undefined &&
		process.env["ROBLOX_PLACE_ID"] !== undefined
	);
}
