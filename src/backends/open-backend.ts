import type { CliOptions, ParallelCount } from "../config/resolved-config.ts";
import { VM_HOST_POOL_SIZE } from "../protocol/studio.ts";
import { nodeChildProcessRunner } from "../utils/child-process.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type {
	BackendConfigSource,
	BackendSettings,
	StudioInstalledCheck,
} from "./backend-settings.ts";
import { isStudioDiscoverable, resolveBackendSettings } from "./backend-settings.ts";
import type { Backend } from "./dispatch-request.ts";
import type { BackendKind } from "./interface.ts";
import { OpenCloudBackend } from "./open-cloud.ts";
import { StudioCliBackend } from "./studio-cli.ts";
import { StudioBackend } from "./studio.ts";
import {
	nodeWebSocketServerFactory,
	type WebSocketServerFactory,
} from "./web-socket-server-factory.ts";

/** What a backend kind can serve, read by the run before it dispatches. */
export interface BackendCapabilities {
	/** Opens the run's place file, so the run builds it before dispatch. */
	readonly opensPlaceFile: boolean;
	/**
	 * Why the backend cannot run `--experimental-vm-parallel`; absent when it
	 * can.
	 */
	readonly vmParallelRefusal?: string;
	/** Why the backend cannot run a workspace; absent when it can. */
	readonly workspaceRefusal?: string;
}

/** Inputs of {@link openBackend}. */
export interface OpenBackendRequest {
	/** Parsed command-line options. */
	readonly cli: CliOptions;
	/** The config of the run's mode. */
	readonly config: BackendConfigSource & {
		readonly experimentalVmParallel?: ParallelCount | undefined;
	};
	/** File system the backend reads and writes. */
	readonly fileSystem: FileSystem;
	/** Reports whether Studio is installed, for the `auto` backend. */
	readonly isStudioInstalled?: StudioInstalledCheck;
	/** Opens the result server of the Studio backends. */
	readonly webSocketServerFactory?: WebSocketServerFactory;
	/** Whether the run is a workspace run. */
	readonly workspace: boolean;
}

/** What each backend kind can serve. */
export const BACKEND_CAPABILITIES: Readonly<Record<BackendKind, BackendCapabilities>> = {
	"open-cloud": {
		opensPlaceFile: true,
		vmParallelRefusal:
			"--experimental-vm-parallel is Studio-only: an Open Cloud session has no " +
			"second Luau VM to run a project in. Use --parallel to shard the run " +
			"across Open Cloud sessions instead.",
	},
	"studio": { opensPlaceFile: false },
	"studio-cli": { opensPlaceFile: true },
};

/**
 * Resolves the backend kind, checks the run fits it, and builds it.
 *
 * @param request - CLI options, config, run layout and seams.
 * @returns The backend the run dispatches to.
 * @throws Error when the backend cannot serve the workspace or the VM
 *   parallelism, or its settings do not resolve.
 */
export function openBackend({
	cli,
	config,
	fileSystem,
	isStudioInstalled = isStudioDiscoverable,
	webSocketServerFactory = nodeWebSocketServerFactory,
}: OpenBackendRequest): Backend {
	const settings = resolveBackendSettings({ cli, config, isStudioInstalled });
	const capabilities = BACKEND_CAPABILITIES[settings.kind];
	assertVmParallel(capabilities, config.experimentalVmParallel);
	return createBackend(settings, { fileSystem, webSocketServerFactory });
}

function createBackend(
	settings: BackendSettings,
	{
		fileSystem,
		webSocketServerFactory,
	}: { fileSystem: FileSystem; webSocketServerFactory: WebSocketServerFactory },
): Backend {
	if (settings.kind === "studio") {
		return new StudioBackend({
			port: settings.port,
			webSocketServerFactory,
		});
	}

	if (settings.kind === "studio-cli") {
		const { kind: _kind, ...options } = settings;
		return new StudioCliBackend({
			...options,
			childProcess: nodeChildProcessRunner,
			fileSystem,
			webSocketServerFactory,
		});
	}

	return new OpenCloudBackend(settings.credentials, { fileSystem });
}

function assertVmParallel(
	capabilities: BackendCapabilities,
	vmParallel: ParallelCount | undefined,
): void {
	if (vmParallel === undefined) {
		return;
	}

	if (capabilities.vmParallelRefusal !== undefined) {
		throw new Error(capabilities.vmParallelRefusal);
	}

	if (typeof vmParallel === "number" && vmParallel > VM_HOST_POOL_SIZE) {
		throw new Error(
			`--experimental-vm-parallel ${vmParallel.toString()} is more than the Studio plugin ` +
				`ships ${VM_HOST_POOL_SIZE.toString()} VM hosts. Pass at most ` +
				`${VM_HOST_POOL_SIZE.toString()}, or pass the flag bare for one VM per project ` +
				"up to that cap.",
		);
	}
}
