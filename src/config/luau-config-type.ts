import * as path from "node:path";

import source from "../../luau/types/config.luau";
import { atomicWrite } from "../utils/atomic-write.ts";
import { errorMessage } from "../utils/error-message.ts";
import type { FileSystem } from "../utils/file-system.ts";

export const LUAU_CONFIG_TYPE_SOURCE: string = source;

/** Folders under the home directory that hold one folder per CLI version. */
export const LUAU_CONFIG_TYPES_FOLDERS = [".jest-roblox", "typedefs"] as const;

const TYPE_MODULE = "config.luau";

interface TypesLocation {
	readonly fileSystem: FileSystem;
	readonly homeDirectory: string;
	readonly version: string;
}

/**
 * Write the Luau Config type module to the versioned home folder.
 * @param location - File system, home folder and version.
 * @returns The folder that holds the type module.
 */
export function writeLuauConfigTypes({
	fileSystem,
	homeDirectory,
	version,
}: TypesLocation): string {
	const directory = path.join(homeDirectory, ...LUAU_CONFIG_TYPES_FOLDERS, version);
	atomicWrite({ contents: source, fileSystem, targetPath: path.join(directory, TYPE_MODULE) });
	return directory;
}

/**
 * Write the Luau Config type module to the versioned home folder if it is not
 * there.
 * @param location - File system, home folder and version.
 * @returns The write failure, or `undefined` when the module is in place.
 */
export function ensureLuauConfigTypes(location: TypesLocation): Error | undefined {
	const { homeDirectory, version } = location;
	const directory = path.join(homeDirectory, ...LUAU_CONFIG_TYPES_FOLDERS, version);
	if (location.fileSystem.existsSync(path.join(directory, TYPE_MODULE))) {
		return undefined;
	}

	try {
		writeLuauConfigTypes(location);
		return undefined;
	} catch (err) {
		return new Error(
			`Could not write the Luau Config types to ${directory}: ${errorMessage(err)}`,
			{ cause: err },
		);
	}
}
