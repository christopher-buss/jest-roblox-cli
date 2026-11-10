import { resolveCredentials } from "@isentinel/roblox-runner";
import type { RunnerCredentials } from "@isentinel/roblox-runner";

import process from "node:process";

import type { CliOptions, ResolvedConfig } from "../config/resolved-config.ts";
import type { BackendKind } from "./interface.ts";
import {
	configuredStudioPath,
	discoverStudioPath,
	isStudioDiscoveryOn,
} from "./studio-discovery.ts";

const ENV_PREFIX = "JEST_";

/** Reports whether Roblox Studio is installed on this machine. */
export type StudioInstalledCheck = () => boolean;

/** Everything the factory needs to build one backend. */
export type BackendSettings =
	| OpenCloudBackendSettings
	| StudioBackendSettings
	| StudioCliBackendSettings;

/** The config fields backend settings read. */
export type BackendConfigSource = Partial<ResolvedConfig> &
	Pick<ResolvedConfig, "backend" | "port">;

/** Inputs of {@link resolveBackendSettings}. */
export interface BackendSettingsRequest {
	/** Parsed command-line options. */
	readonly cli: CliOptions;
	/** The config of the run's mode. */
	readonly config: BackendConfigSource;
	/** Reports whether Studio is installed, for the `auto` backend. */
	readonly isStudioInstalled: StudioInstalledCheck;
}

/** What the factory needs to build an `open-cloud` backend. */
interface OpenCloudBackendSettings {
	/** API key and the universe and place to run against. */
	readonly credentials: RunnerCredentials;
	/** Which backend these settings build. */
	readonly kind: "open-cloud";
}

/** Settings of the attached `studio` backend. */
interface StudioBackendSettings {
	/** Which backend these settings build. */
	readonly kind: "studio";
	/** WebSocket port the plugin connects to. */
	readonly port: number;
}

/** Settings of the self-launched `studio-cli` backend. */
interface StudioCliBackendSettings {
	/** Show the Studio window; CLI-only. */
	readonly headed: boolean | undefined;
	/** Run Studio hidden. */
	readonly hiddenDesktop: boolean | undefined;
	/** Which backend these settings build. */
	readonly kind: "studio-cli";
	/** Studio plugins folder. */
	readonly pluginsDirectory: string | undefined;
	/** Studio executable override. */
	readonly studioPath: string | undefined;
}

/**
 * Reports whether Studio discovery finds a Studio install.
 *
 * @param discover - Finds the Studio path, or throws when there is none.
 * @param isDiscoveryOn - Reads the discovery switch; throws on an invalid value.
 * @returns True when discovery is on and `discover` does not throw.
 */
export function isStudioDiscoverable(
	discover: () => string = discoverStudioPath,
	isDiscoveryOn: () => boolean = isStudioDiscoveryOn,
): boolean {
	if (!isDiscoveryOn()) {
		return false;
	}

	try {
		discover();
		return true;
	} catch {
		return false;
	}
}

/**
 * Resolves the backend kind and the settings that kind needs.
 *
 * @param request - CLI options, config and the Studio check.
 * @returns The settings of the run's backend.
 * @throws Error when Open Cloud credentials are missing.
 */
export function resolveBackendSettings({
	cli,
	config,
	isStudioInstalled,
}: BackendSettingsRequest): BackendSettings {
	const kind = resolveAutoBackend(config, isStudioInstalled);
	if (kind === "studio") {
		return { kind, port: config.port };
	}

	if (kind === "studio-cli") {
		return {
			headed: cli.headed,
			hiddenDesktop: config.hiddenDesktop,
			kind,
			pluginsDirectory: config.pluginsDirectory,
			studioPath: config.studioPath,
		};
	}

	return { credentials: resolveOpenCloudCredentials(cli, config), kind };
}

function resolveAutoBackend(
	{ backend, studioPath }: Pick<BackendConfigSource, "backend" | "studioPath">,
	isStudioInstalled: StudioInstalledCheck,
): BackendKind {
	if (backend !== "auto") {
		return backend;
	}

	if (configuredStudioPath(studioPath) !== undefined || isStudioInstalled()) {
		process.stderr.write("Backend: studio-cli (Studio installed)\n");
		return "studio-cli";
	}

	process.stderr.write("Backend: open-cloud (Studio not found)\n");
	return "open-cloud";
}

function resolveOpenCloudCredentials(
	cli: CliOptions,
	config: BackendConfigSource,
): RunnerCredentials {
	return resolveCredentials({
		defaults: { placeId: config.placeId, universeId: config.universeId },
		envPrefix: ENV_PREFIX,
		overrides: { apiKey: cli.apiKey, placeId: cli.placeId, universeId: cli.universeId },
	});
}
