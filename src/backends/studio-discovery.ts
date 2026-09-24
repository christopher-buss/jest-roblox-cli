// cspell:ignore LOCALAPPDATA mtimes
import type { Dirent } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";

import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";

export interface StudioDiscoveryOptions {
	/**
	 * Environment to read discovery hints from (Windows `LOCALAPPDATA`).
	 * Defaults to `process.env`; injectable so tests stub it.
	 */
	environment?: NodeJS.ProcessEnv | undefined;
	/** Where the executable is probed. Defaults to the real filesystem. */
	fileSystem?: FileSystem;
	/**
	 * Explicit Studio executable path (from `studioPath` config key, the
	 * `--studioPath` CLI flag, or `JEST_ROBLOX_STUDIO_PATH`). Takes precedence
	 * over per-OS discovery.
	 */
	override?: string | undefined;
	/**
	 * OS to discover for. Defaults to `process.platform`; injectable for
	 * tests.
	 */
	platform?: NodeJS.Platform | undefined;
}

const STUDIO_PATH_ENV = "JEST_ROBLOX_STUDIO_PATH";

const WINDOWS_STUDIO_EXECUTABLE = "RobloxStudioBeta.exe";
const MACOS_STUDIO_EXECUTABLE = "/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudioBeta";

const NOT_FOUND_HINT =
	"Install Roblox Studio, or set studioPath (config key, --studioPath, or " +
	"JEST_ROBLOX_STUDIO_PATH).";

export interface UserDirectoryOptions {
	/** Defaults to `process.env`. */
	environment?: NodeJS.ProcessEnv | undefined;
	/** Defaults to `os.homedir()`. */
	homeDirectory?: string | undefined;
	/** Defaults to `process.platform`. */
	platform?: NodeJS.Platform | undefined;
}

export interface UserDirectories {
	/** The folder Studio loads local plugins from. */
	readonly plugins: string;
	/** The CLI's own per-user state, outside anything Studio watches. */
	readonly state: string;
}

/**
 * The Studio path the user named: the `studioPath` setting, else
 * `JEST_ROBLOX_STUDIO_PATH`. An empty variable names nothing.
 */
export function configuredStudioPath(
	studioPath: string | undefined,
	environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const fromEnvironment = environment[STUDIO_PATH_ENV];
	return studioPath ?? (fromEnvironment === "" ? undefined : fromEnvironment);
}

/**
 * Resolve the Roblox Studio executable studio-cli should launch. An explicit
 * `override` wins; otherwise probe the known per-OS install locations and pick
 * the newest `RobloxStudioBeta.exe`. Throws a clear, actionable error when no
 * executable can be found so the CLI surfaces "install Studio or set
 * studioPath" rather than a downstream spawn failure.
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

		// Normalize so the override resolves to the same path form as a
		// discovered executable (forward slashes, upper-cased drive letter).
		return normalizeWindowsPath(override);
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
 * The per-user folders the Managed Plugin lives in and is tracked from, or
 * undefined where this OS has no known plugins folder.
 */
export function discoverUserDirectories({
	environment = process.env,
	homeDirectory = os.homedir(),
	platform = process.platform,
}: UserDirectoryOptions = {}): undefined | UserDirectories {
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

function notFound(): Error {
	return new Error(`Roblox Studio not found. ${NOT_FOUND_HINT}`);
}

/**
 * The most recently modified `RobloxStudioBeta.exe` across the version
 * directories, normalized. Undefined when no version directory holds one —
 * `Versions` exists but every entry is a stale/partial install.
 */
function findNewestStudioExecutable(
	fileSystem: FileSystem,
	versionsDirectory: string,
	entries: Array<Dirent>,
): string | undefined {
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

	const newest = findNewestStudioExecutable(fileSystem, versionsDirectory, entries);
	if (newest === undefined) {
		throw notFound();
	}

	return newest;
}

function discoverMacOs(fileSystem: FileSystem): string {
	if (!fileSystem.existsSync(MACOS_STUDIO_EXECUTABLE)) {
		throw notFound();
	}

	return MACOS_STUDIO_EXECUTABLE;
}
