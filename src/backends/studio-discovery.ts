// cspell:ignore LOCALAPPDATA mtimes
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";

import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";

export interface StudioDiscoveryOptions {
	/**
	 * Environment to read discovery hints from (Windows `LOCALAPPDATA`).
	 * Defaults to `process.env`; injectable so tests stub it.
	 */
	environment?: NodeJS.ProcessEnv;
	/**
	 * Explicit Studio executable path (from `studioPath` config key, the
	 * `--studioPath` CLI flag, or `JEST_ROBLOX_STUDIO_PATH`). Takes precedence
	 * over per-OS discovery.
	 */
	override?: string;
	/** OS to discover for. Defaults to `process.platform`; injectable for tests. */
	platform?: NodeJS.Platform;
}

const WINDOWS_STUDIO_EXECUTABLE = "RobloxStudioBeta.exe";
const MACOS_STUDIO_EXECUTABLE = "/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudioBeta";

const NOT_FOUND_HINT =
	"Install Roblox Studio, or set studioPath (config key, --studioPath, or " +
	"JEST_ROBLOX_STUDIO_PATH).";

/**
 * Resolve the Roblox Studio executable studio-cli should launch. An explicit
 * `override` wins; otherwise probe the known per-OS install locations and pick
 * the newest `RobloxStudioBeta.exe`. Throws a clear, actionable error when no
 * executable can be found so the CLI surfaces "install Studio or set
 * studioPath" rather than a downstream spawn failure.
 */
export function discoverStudioPath(options: StudioDiscoveryOptions = {}): string {
	const { environment = process.env, override, platform = process.platform } = options;

	if (override !== undefined) {
		const stat = fs.statSync(override, { throwIfNoEntry: false });
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
		return discoverWindows(environment);
	}

	if (platform === "darwin") {
		return discoverMacOs();
	}

	throw new Error(
		`studio-cli backend has no Studio auto-discovery for platform "${platform}". ` +
			"Set studioPath to point at your Roblox Studio executable.",
	);
}

function notFound(): Error {
	return new Error(`Roblox Studio not found. ${NOT_FOUND_HINT}`);
}

function discoverWindows(environment: NodeJS.ProcessEnv): string {
	const localAppData = environment["LOCALAPPDATA"];
	if (localAppData === undefined || localAppData === "") {
		throw new Error(`Cannot locate Roblox Studio: LOCALAPPDATA is not set. ${NOT_FOUND_HINT}`);
	}

	const versionsDirectory = path.join(localAppData, "Roblox", "Versions");
	let entries: Array<fs.Dirent>;
	try {
		entries = fs.readdirSync(versionsDirectory, { withFileTypes: true });
	} catch {
		throw notFound();
	}

	let newest: undefined | { mtimeMs: number; path: string };
	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}

		const executable = path.join(versionsDirectory, entry.name, WINDOWS_STUDIO_EXECUTABLE);
		const stat = fs.statSync(executable, { throwIfNoEntry: false });
		if (stat === undefined) {
			continue;
		}

		if (newest === undefined || stat.mtimeMs > newest.mtimeMs) {
			newest = { mtimeMs: stat.mtimeMs, path: normalizeWindowsPath(executable) };
		}
	}

	if (newest === undefined) {
		throw notFound();
	}

	return newest.path;
}

function discoverMacOs(): string {
	if (!fs.existsSync(MACOS_STUDIO_EXECUTABLE)) {
		throw notFound();
	}

	return MACOS_STUDIO_EXECUTABLE;
}
