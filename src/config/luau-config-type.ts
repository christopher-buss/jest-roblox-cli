import * as path from "node:path";

import source from "../../luau/types/config.luau";
import { atomicWrite } from "../utils/atomic-write.ts";
import { errorMessage } from "../utils/error-message.ts";
import type { FileSystem } from "../utils/file-system.ts";

export const LUAU_CONFIG_TYPES_FOLDERS = [".jest-roblox", "typedefs"] as const;

const TYPE_MODULE = "config.luau";

interface TypesLocation {
	readonly fileSystem: FileSystem;
	readonly homeDirectory: string;
	readonly version: string;
}

/**
 * Publish the type module atomically so concurrent evaluators read a whole file.
 * @param root0 - Versioned home and filesystem.
 * @returns The alias target directory.
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
 * Bootstrap a missing alias target before the evaluator opens it.
 * @param location - Versioned home and filesystem.
 * @returns The write failure, when bootstrap fails.
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
