import path from "node:path";

const LUA_EXT = ".lua";
const LUAU_EXT = ".luau";
/**
 * Exported because rojo reads a plain `.json` as a module and every other
 * `.json` as a description of an instance built elsewhere, so a consumer
 * splitting the two spells this out and would otherwise spell it alone.
 */
export const JSON_EXT = ".json";

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

/**
 * Recognizes named project files without accepting backup suffixes.
 * @param fileName - Complete basename to classify.
 * @returns Whether the complete basename is a named Rojo project file.
 */
export function isRojoProjectFileName(fileName: string): boolean {
	return ROJO_FILE_REGEX.test(fileName);
}

/**
 * Removes supported module suffixes and script-side qualifiers.
 * @param filePath - Filesystem path to classify or resolve.
 * @returns The path with supported suffixes removed; unsupported extensions stay intact.
 */
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

/**
 * Normalizes legacy Lua suffixes while retaining other filenames.
 * @param filePath - Filesystem path to classify or resolve.
 * @returns The original path, with a terminal .lua changed to .luau.
 */
export function convertToLuau(filePath: string): string {
	const extension = path.extname(filePath);
	if (extension === LUA_EXT) {
		return filePath.slice(0, -extension.length) + LUAU_EXT;
	}

	return filePath;
}

/**
 * Checks containment using the native host path vocabulary.
 * @param filePath - Filesystem path to classify or resolve.
 * @param directoryPath - Candidate containing directory.
 * @returns Whether the native relative path stays within the directory.
 */
export function isPathDescendantOf(filePath: string, directoryPath: string): boolean {
	return !path.relative(directoryPath, filePath).startsWith("..");
}
