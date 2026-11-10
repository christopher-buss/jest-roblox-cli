// cspell:ignore LOCALAPPDATA mtimes
import { type } from "arktype";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";

import { absolutePathSchema } from "../config/option-schemas.ts";
import type { Dirent, FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";

/** Inputs for finding the Studio executable. */
export interface StudioDiscoveryOptions {
	/** Environment to read discovery hints from. */
	environment?: NodeJS.ProcessEnv | undefined;
	/** Where the executable is probed. */
	fileSystem?: FileSystem;
	/** Explicit Studio executable path; wins over per-OS discovery. */
	override?: string | undefined;
	/** OS to discover for. */
	platform?: NodeJS.Platform | undefined;
}

const STUDIO_PATH_ENV = "JEST_ROBLOX_STUDIO_PATH";
const PLUGINS_DIRECTORY_ENV = "JEST_ROBLOX_PLUGINS_DIR";
const DISCOVERY_ENV = "JEST_ROBLOX_STUDIO_DISCOVERY";

const WINDOWS_STUDIO_EXECUTABLE = "RobloxStudioBeta.exe";
const MACOS_STUDIO_EXECUTABLES = [
	"/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio",
	"/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudioBeta",
];

const NOT_FOUND_HINT =
	"Install Roblox Studio, or set studioPath (config key, --studioPath, or " +
	"JEST_ROBLOX_STUDIO_PATH).";

/** Inputs for finding the per-user Studio folders. */
export interface UserDirectoryOptions {
	/** Environment to read the plugins folder from. */
	environment?: NodeJS.ProcessEnv | undefined;
	/** The user's home folder. */
	homeDirectory?: string | undefined;
	/** OS to discover for. */
	platform?: NodeJS.Platform | undefined;
	/** Configured plugins folder; overrides the environment and the default. */
	pluginsDirectory?: string | undefined;
}

/** Per-user folders the CLI uses. */
export interface UserDirectories {
	/** The folder Studio loads local plugins from. */
	readonly plugins: string;
	/** The CLI's own per-user state, outside anything Studio watches. */
	readonly state: string;
}

/**
 * The Studio path the user named: the setting, else the environment variable.
 *
 * @param studioPath - The `studioPath` setting.
 * @param environment - Environment to read the variable from.
 * @returns The named path, or undefined when none is named.
 */
export function configuredStudioPath(
	studioPath: string | undefined,
	environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
	return studioPath ?? fromEnvironment(environment, STUDIO_PATH_ENV);
}

/**
 * Reads whether Studio discovery is on from `JEST_ROBLOX_STUDIO_DISCOVERY`.
 *
 * @param environment - Environment to read the variable from.
 * @returns False only when the variable is `off`.
 * @throws Error when the variable is set to a value other than `on` or `off`.
 */
export function isStudioDiscoveryOn(environment: NodeJS.ProcessEnv = process.env): boolean {
	const value = fromEnvironment(environment, DISCOVERY_ENV);
	if (value === undefined || value === "on") {
		return true;
	}

	if (value === "off") {
		return false;
	}

	throw new Error(`${DISCOVERY_ENV} must be "on" or "off" (was "${value}")`);
}

/**
 * Resolve the Roblox Studio executable studio-cli should launch.
 *
 * @param options - Override, environment, file system, and platform.
 * @returns The normalized Studio executable path.
 * @throws Error when no Studio executable is found or discovery is off.
 */
export function discoverStudioPath({
	environment = process.env,
	fileSystem = nodeFileSystem,
	override,
	platform = process.platform,
}: StudioDiscoveryOptions = {}): string {
	if (override !== undefined) {
		const stat = fileSystem.statSync(override, { throwIfNoEntry: false });
		if (stat === undefined) {
			throw new Error(`Roblox Studio not found at studioPath override: ${override}`);
		}

		if (!stat.isFile()) {
			throw new Error(`studioPath override is not a file: ${override}`);
		}

		return normalizeWindowsPath(override);
	}

	if (!isStudioDiscoveryOn(environment)) {
		throw new Error(
			`Roblox Studio discovery is off (${DISCOVERY_ENV}=off). Unset ${DISCOVERY_ENV}, ` +
				"or set studioPath (config key, --studioPath, or JEST_ROBLOX_STUDIO_PATH).",
		);
	}

	if (platform === "win32") {
		return discoverWindows(fileSystem, environment);
	}

	if (platform === "darwin") {
		return discoverMacOs(fileSystem);
	}

	throw new Error(
		`studio-cli backend has no Studio auto-discovery for platform "${platform}". ` +
			"Set studioPath to point at your Roblox Studio executable.",
	);
}

/**
 * The per-user folders the Managed Plugin lives in and is tracked from.
 *
 * @param options - Environment, home folder, platform, and plugins folder.
 * @returns The plugins and state folders, or undefined.
 */
export function discoverUserDirectories({
	environment = process.env,
	homeDirectory = os.homedir(),
	platform = process.platform,
	pluginsDirectory,
}: UserDirectoryOptions = {}): undefined | UserDirectories {
	const configured = pluginsDirectory ?? environmentPluginsDirectory(environment);
	const defaults = defaultUserDirectories({ environment, homeDirectory, platform });
	if (defaults === undefined || configured === undefined) {
		return defaults;
	}

	return {
		...defaults,
		plugins: platform === "win32" ? normalizeWindowsPath(configured) : configured,
	};
}

function fromEnvironment(environment: NodeJS.ProcessEnv, name: string): string | undefined {
	const value = environment[name];
	return value === "" ? undefined : value;
}

function notFound(): Error {
	return new Error(`Roblox Studio not found. ${NOT_FOUND_HINT}`);
}

function findNewestStudioExecutable({
	entries,
	fileSystem,
	versionsDirectory,
}: {
	readonly entries: Array<Dirent>;
	readonly fileSystem: FileSystem;
	readonly versionsDirectory: string;
}): string | undefined {
	let newest: undefined | { mtimeMs: number; path: string };
	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}

		const executable = path.join(versionsDirectory, entry.name, WINDOWS_STUDIO_EXECUTABLE);
		const stat = fileSystem.statSync(executable, { throwIfNoEntry: false });
		if (stat === undefined) {
			continue;
		}

		if (newest === undefined || stat.mtimeMs > newest.mtimeMs) {
			newest = { mtimeMs: stat.mtimeMs, path: normalizeWindowsPath(executable) };
		}
	}

	return newest?.path;
}

function discoverWindows(fileSystem: FileSystem, environment: NodeJS.ProcessEnv): string {
	const localAppData = environment["LOCALAPPDATA"];
	if (localAppData === undefined || localAppData === "") {
		throw new Error(`Cannot locate Roblox Studio: LOCALAPPDATA is not set. ${NOT_FOUND_HINT}`);
	}

	const versionsDirectory = path.join(localAppData, "Roblox", "Versions");
	let entries: Array<Dirent>;
	try {
		entries = fileSystem.readdirSync(versionsDirectory, { withFileTypes: true });
	} catch {
		throw notFound();
	}

	const newest = findNewestStudioExecutable({ entries, fileSystem, versionsDirectory });
	if (newest === undefined) {
		throw notFound();
	}

	return newest;
}

function discoverMacOs(fileSystem: FileSystem): string {
	const executable = MACOS_STUDIO_EXECUTABLES.find((candidate) => {
		return fileSystem.existsSync(candidate);
	});
	if (executable === undefined) {
		throw notFound();
	}

	return executable;
}

function environmentPluginsDirectory(environment: NodeJS.ProcessEnv): string | undefined {
	const value = fromEnvironment(environment, PLUGINS_DIRECTORY_ENV);
	if (value === undefined) {
		return undefined;
	}

	const result = absolutePathSchema(value);
	if (result instanceof type.errors) {
		throw new Error(`${PLUGINS_DIRECTORY_ENV} ${result.summary}`);
	}

	return result;
}

function defaultUserDirectories({
	environment,
	homeDirectory,
	platform,
}: {
	environment: NodeJS.ProcessEnv;
	homeDirectory: string;
	platform: NodeJS.Platform;
}): undefined | UserDirectories {
	const localAppData = environment["LOCALAPPDATA"];
	if (platform === "win32" && localAppData !== undefined && localAppData !== "") {
		return {
			plugins: normalizeWindowsPath(path.join(localAppData, "Roblox", "Plugins")),
			state: normalizeWindowsPath(path.join(localAppData, "jest-roblox")),
		};
	}

	if (platform === "darwin") {
		return {
			plugins: path.posix.join(homeDirectory, "Documents", "Roblox", "Plugins"),
			state: path.posix.join(homeDirectory, "Library", "Caches", "jest-roblox"),
		};
	}

	return undefined;
}
