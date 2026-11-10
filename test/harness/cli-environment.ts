import path from "node:path";
import nodeProcess from "node:process";

import { createSandboxDirectory } from "#test/harness/sandbox-root.ts";

// cspell:ignore LOCALAPPDATA MSYSTEM PATHEXT PROGRAMDATA WINDIR
const ALLOWED_ENV_VARS = [
	"CI",
	"ComSpec",
	"JEST_ROBLOX_OCALE_MAX_RETRIES",
	"MSYSTEM",
	"NODE_OPTIONS",
	"NUMBER_OF_PROCESSORS",
	"PATH",
	"PATHEXT",
	"PNPM_HOME",
	"PROGRAMDATA",
	"ProgramData",
	"ProgramFiles",
	"ProgramFiles(x86)",
	"SystemDrive",
	"SystemRoot",
	"TEMP",
	"TERM",
	"TMP",
	"WINDIR",
] as const;

let hermeticHome: string | undefined;

export function hermeticEnvironment(): NodeJS.ProcessEnv {
	hermeticHome ??= createSandboxDirectory();
	return {
		APPDATA: path.join(hermeticHome, "AppData", "Roaming"),
		HOME: hermeticHome,
		JEST_ROBLOX_PLUGINS_DIR: path.join(hermeticHome, "Plugins"),
		JEST_ROBLOX_STUDIO_DISCOVERY: "off",
		LOCALAPPDATA: path.join(hermeticHome, "AppData", "Local"),
		USERPROFILE: hermeticHome,
	};
}

export function buildCliEnvironment(
	overrides?: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = { FORCE_COLOR: "0", NO_COLOR: "1" };

	for (const key of ALLOWED_ENV_VARS) {
		const value = nodeProcess.env[key];
		if (value !== undefined) {
			environment[key] = value;
		}
	}

	Object.assign(environment, hermeticEnvironment());

	const overrideEntries = Object.entries(overrides ?? {});
	for (const [key, value] of overrideEntries) {
		if (value === undefined) {
			delete environment[key];
		} else {
			environment[key] = value;
		}
	}

	return environment;
}
