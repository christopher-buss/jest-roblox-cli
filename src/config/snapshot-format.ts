import type { TsconfigMappingCache, TsconfigReader } from "../executor/tsconfig-mappings.ts";
import {
	isLuauProject,
	nodeTsconfigReader,
	resolveAllTsconfigMappings,
} from "../executor/tsconfig-mappings.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import type { ResolvedConfig } from "./schema.ts";

/**
 * How a project's tsconfigs are found, read, and remembered across projects.
 */
export interface TsconfigLookup {
	cache: TsconfigMappingCache;
	/** Where the tsconfigs are read. Defaults to the real filesystem. */
	fileSystem?: FileSystem;
	/** How a tsconfig is located. Defaults to the real reader. */
	tsconfigReader?: TsconfigReader;
}

/**
 * Resolve the snapshot format a project runs under: `printBasicPrototype`
 * follows the project's language, because Jest-Roblox prints `Table {` where
 * JS Jest prints `{`. Idempotent — a config that already carries the flag
 * (user-declared, or resolved by an earlier caller) comes back untouched.
 */
export function resolveSnapshotFormat(
	config: ResolvedConfig,
	testFiles: ReadonlyArray<string>,
	{ cache, fileSystem = nodeFileSystem, tsconfigReader = nodeTsconfigReader }: TsconfigLookup,
): ResolvedConfig {
	if (config.snapshotFormat?.printBasicPrototype !== undefined) {
		return config;
	}

	const mappings = resolveAllTsconfigMappings(config.rootDir, cache, fileSystem, tsconfigReader);
	return {
		...config,
		snapshotFormat: {
			...config.snapshotFormat,
			printBasicPrototype: isLuauProject(testFiles, mappings),
		},
	};
}
