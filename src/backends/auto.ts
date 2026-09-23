import { resolveCredentials } from "@isentinel/roblox-runner";
import type { RunnerCredentials } from "@isentinel/roblox-runner";

import process from "node:process";

import type { CliOptions, ResolvedConfig } from "../config/schema.ts";
import type { Backend, BackendKind, ParallelOption } from "./interface.ts";
import { createOpenCloudBackend } from "./open-cloud.ts";
import { createStudioCliBackend } from "./studio-cli.ts";
import { configuredStudioPath, discoverStudioPath } from "./studio-discovery.ts";
import { createStudioBackend } from "./studio.ts";
import { VM_HOST_POOL_SIZE } from "./vm-parallel.ts";
import { nodeWebSocketServerFactory } from "./web-socket-server-factory.ts";
import type { WebSocketServerFactory } from "./web-socket-server-factory.ts";

const ENV_PREFIX = "JEST_";

export type StudioInstalledCheck = () => boolean;

export interface BackendResolutionOptions {
	isStudioInstalled?: StudioInstalledCheck;
	webSocketServerFactory?: WebSocketServerFactory;
}

export function isStudioDiscoverable(discover: () => string = discoverStudioPath): boolean {
	try {
		discover();
		return true;
	} catch {
		return false;
	}
}

/**
 * The Auto Backend: `studio-cli` when Roblox Studio is installed, otherwise
 * `open-cloud`. A configured Studio path counts as installed, so a wrong path
 * fails at launch instead of silently moving the run to Open Cloud.
 */
export function resolveAutoBackend(
	{ backend, studioPath }: Pick<ResolvedConfig, "backend" | "studioPath">,
	isStudioInstalled: StudioInstalledCheck,
): BackendKind {
	if (backend !== "auto") {
		return backend;
	}

	if (configuredStudioPath(studioPath) !== undefined || isStudioInstalled()) {
		process.stderr.write("Backend: studio-cli (Studio installed)\n");
		return "studio-cli";
	}

	process.stderr.write("Backend: open-cloud (Studio not installed)\n");
	return "open-cloud";
}

// eslint-disable-next-line ts/require-await -- Async so a bad config rejects rather than throws: `RunSeams.resolveBackend` is awaited, and its fakes resolve.
export async function resolveBackendAsync(
	cli: CliOptions,
	config: ResolvedConfig,
	{
		isStudioInstalled = isStudioDiscoverable,
		webSocketServerFactory = nodeWebSocketServerFactory,
	}: BackendResolutionOptions = {},
): Promise<Backend> {
	const kind = resolveAutoBackend(config, isStudioInstalled);
	const backend = createBackend(kind, cli, config, webSocketServerFactory);
	assertVmParallel(backend, config.experimentalVmParallel);
	return backend;
}

function buildCredentials(cli: CliOptions, config: ResolvedConfig): RunnerCredentials {
	return resolveCredentials({
		defaults: { placeId: config.placeId, universeId: config.universeId },
		envPrefix: ENV_PREFIX,
		overrides: { apiKey: cli.apiKey, placeId: cli.placeId, universeId: cli.universeId },
	});
}

function createBackend(
	kind: BackendKind,
	cli: CliOptions,
	config: ResolvedConfig,
	webSocketServerFactory: WebSocketServerFactory,
): Backend {
	if (kind === "studio") {
		return createStudioBackend({
			port: config.port,
			timeout: config.timeout,
			webSocketServerFactory,
		});
	}

	if (kind === "studio-cli") {
		// `headed` is CLI-only — read straight from `cli`, never from `config`.
		return createStudioCliBackend({
			headed: cli.headed,
			studioPath: config.studioPath,
			timeout: config.timeout,
		});
	}

	return createOpenCloudBackend(buildCredentials(cli, config));
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
