import path from "node:path";

const LUA_EXT = ".lua";
const LUAU_EXT = ".luau";
const JSON_EXT = ".json";
const TOML_EXT = ".toml";

export const ROJO_MODULE_EXTS: ReadonlySet<string> = new Set([JSON_EXT, LUAU_EXT, TOML_EXT]);
export const ROJO_SCRIPT_EXTS: ReadonlySet<string> = new Set([LUAU_EXT]);

export const INIT_NAME = "init";

export const SERVER_SUB_EXTENSION = ".server";
export const CLIENT_SUB_EXTENSION = ".client";
export const MODULE_SUB_EXTENSION = "";

const ROJO_FILE_REGEX = /^.+\.project\.json$/;

export const ROJO_DEFAULT_NAME = "default.project.json";
export const ROJO_OLD_NAME = "roblox-project.json";

export function isRojoProjectFileName(fileName: string): boolean {
	return ROJO_FILE_REGEX.test(fileName);
}

export function stripRojoExtensions(filePath: string): string {
	let stripped = filePath;
	const extension = path.extname(stripped);
	if (ROJO_MODULE_EXTS.has(extension)) {
		stripped = stripped.slice(0, -extension.length);
		if (ROJO_SCRIPT_EXTS.has(extension)) {
			const subExtension = path.extname(stripped);
			if (subExtension === SERVER_SUB_EXTENSION || subExtension === CLIENT_SUB_EXTENSION) {
				stripped = stripped.slice(0, -subExtension.length);
			}
		}
	}

	return stripped;
}

export function convertToLuau(filePath: string): string {
	const extension = path.extname(filePath);
	if (extension === LUA_EXT) {
		return filePath.slice(0, -extension.length) + LUAU_EXT;
	}

	return filePath;
}

export function isPathDescendantOf(filePath: string, directoryPath: string): boolean {
	return directoryPath === filePath || !path.relative(directoryPath, filePath).startsWith("..");
}
