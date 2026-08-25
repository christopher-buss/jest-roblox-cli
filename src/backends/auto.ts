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
	isExplicitMultiShard,
	type ParallelOption,
} from "./interface.ts";
import { createOpenCloudBackend } from "./open-cloud.ts";
import { createStudioCliBackend } from "./studio-cli.ts";
import { createStudioBackend } from "./studio.ts";
import { VM_HOST_POOL_SIZE } from "./vm-parallel.ts";

const ENV_PREFIX = "JEST_";

const STUDIO_BUSY_PATTERN = /previous call to start play session/i;

const NO_BACKEND_MESSAGE =
	"No backend available: Studio plugin not detected and no Open Cloud " +
	"credentials found. Set ROBLOX_OPEN_CLOUD_API_KEY, ROBLOX_UNIVERSE_ID, " +
	"and ROBLOX_PLACE_ID (or pass --apiKey, --universeId, --placeId; " +
	"or set universeId/placeId in jest.config.ts).";

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

	public async closeAsync(): Promise<void> {
		await this.studio.closeAsync?.();
	}

	public async runTestsAsync(options: BackendOptions): Promise<BackendResult> {
		try {
			return await this.studio.runTestsAsync(options);
		} catch (err) {
			const isStudioBusy =
				(err instanceof LuauScriptError && STUDIO_BUSY_PATTERN.test(err.message)) ||
				(err instanceof Error && "code" in err && err.code === "EADDRINUSE");
			if (isStudioBusy) {
				process.stderr.write("Studio busy, falling back to Open Cloud\n");
				return createOpenCloudBackend(this.credentials).runTestsAsync(options);
			}

			throw err;
		}
	}
}

export async function probeStudioPluginAsync(
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

export async function resolveBackendAsync(
	cli: CliOptions,
	config: ResolvedConfig,
	probe: (
		port: number,
		timeoutMs: number,
	) => Promise<ProbeDetected | ProbeResult> = probeStudioPluginAsync,
): Promise<Backend> {
	const backend = await resolveBackendKindAsync(cli, config, probe);
	assertVmParallel(backend, config.experimentalVmParallel);
	return backend;
}

// studio-cli drives a single Studio instance, so it cannot shard. Reject the
// request up front (the CLI otherwise drops `--parallel` for non-open-cloud
// backends, which would silently ignore the user's intent).
function assertStudioCliSerial(parallel: ParallelOption): void {
	if (isExplicitMultiShard(parallel)) {
		throw new Error(
			"studio-cli backend is serial (one Studio instance); --parallel > 1 is not supported.",
		);
	}
}

function buildCredentials(cli: CliOptions, config: ResolvedConfig): RunnerCredentials {
	return resolveCredentials({
		defaults: { placeId: config.placeId, universeId: config.universeId },
		envPrefix: ENV_PREFIX,
		overrides: { apiKey: cli.apiKey, placeId: cli.placeId, universeId: cli.universeId },
	});
}

/**
 * The backend an explicit `backend:` setting selects, or undefined when the
 * config leaves the choice to auto-detection.
 */
function createExplicitBackend(cli: CliOptions, config: ResolvedConfig): Backend | undefined {
	if (config.backend === "studio") {
		return createStudioBackend({ port: config.port, timeout: config.timeout });
	}

	if (config.backend === "studio-cli") {
		assertStudioCliSerial(config.parallel);
		// `headed` is CLI-only — read straight from `cli`, never from `config`.
		return createStudioCliBackend({
			headed: cli.headed,
			studioPath: config.studioPath,
			timeout: config.timeout,
		});
	}

	if (config.backend === "open-cloud") {
		return createOpenCloudBackend(buildCredentials(cli, config));
	}

	return undefined;
}

function hasUserOverrides(cli: CliOptions): boolean {
	return cli.apiKey !== undefined || cli.universeId !== undefined || cli.placeId !== undefined;
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

/**
 * Auto-detection: probe for a live Studio plugin first, fall back to Open
 * Cloud when credentials resolve, and otherwise fail with the actionable
 * "no backend" error.
 */
async function resolveAutoBackendAsync({
	cli,
	config,
	probe,
}: {
	cli: CliOptions;
	config: ResolvedConfig;
	probe: (port: number, timeoutMs: number) => Promise<ProbeDetected | ProbeResult>;
}): Promise<Backend> {
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

	throw new Error(NO_BACKEND_MESSAGE);
}

async function resolveBackendKindAsync(
	cli: CliOptions,
	config: ResolvedConfig,
	probe: (port: number, timeoutMs: number) => Promise<ProbeDetected | ProbeResult>,
): Promise<Backend> {
	const explicit = createExplicitBackend(cli, config);
	if (explicit !== undefined) {
		return explicit;
	}

	return resolveAutoBackendAsync({ cli, config, probe });
}

/**
 * What in-session parallelism can serve, checked before a run starts.
 *
 * Against the *resolved* backend, so `--backend auto` landing on Open Cloud is
 * rejected the same way an explicit `--backend open-cloud` is, rather than
 * running with the flag silently ignored.
 */
function assertVmParallel(backend: Backend, vmParallel: ParallelOption): void {
	if (vmParallel === undefined) {
		return;
	}

	// The actor hosts that give each project its own Luau VM need plugin
	// identity to read `ModuleScript.Source`, and an Open Cloud session runs no
	// scripts to host them.
	if (backend.kind === "open-cloud") {
		throw new Error(
			"--experimental-vm-parallel is Studio-only: an Open Cloud session has no " +
				"second Luau VM to run a project in. Use --parallel to shard the run " +
				"across Open Cloud sessions instead.",
		);
	}

	// The hosts are declared in the plugin's rojo project, so the pool is fixed
	// when the plugin is built. An explicit count above it is a request the
	// plugin cannot serve: say so rather than quietly run fewer VMs than asked
	// for. Bare (`"auto"`) asks for as many as the run can use and accepts the
	// cap by construction.
	if (typeof vmParallel === "number" && vmParallel > VM_HOST_POOL_SIZE) {
		throw new Error(
			`--experimental-vm-parallel ${vmParallel.toString()} is more than the Studio plugin ` +
				`ships ${VM_HOST_POOL_SIZE.toString()} VM hosts. Pass at most ` +
				`${VM_HOST_POOL_SIZE.toString()}, or pass the flag bare for one VM per project ` +
				"up to that cap.",
		);
	}
}
