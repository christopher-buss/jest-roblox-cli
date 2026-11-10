import type { ResolvedConfig } from "../config/resolved-config.ts";
import type { TsconfigMappingCache, TsconfigReader } from "../tsconfig/tsconfig-mappings.ts";
import { isLuauProject, resolveAllTsconfigMappings } from "../tsconfig/tsconfig-mappings.ts";
import type { FileSystem } from "../utils/file-system.ts";

/** Inputs for `resolveSnapshotFormat`. */
export interface SnapshotFormatRequest extends TsconfigLookup {
	/** Project config to resolve. */
	readonly config: ResolvedConfig;
	/** Project test files, used to detect a Luau project. */
	readonly testFiles: ReadonlyArray<string>;
}

interface TsconfigLookup {
	cache: TsconfigMappingCache;
	fileSystem: FileSystem;
	tsconfigReader: TsconfigReader;
}

/**
 * Resolve `printBasicPrototype` from the project's language.
 * @param options - Config, test files and tsconfig lookup.
 * @returns The config with `snapshotFormat.printBasicPrototype` set.
 */
export function resolveSnapshotFormat({
	cache,
	config,
	fileSystem,
	testFiles,
	tsconfigReader,
}: SnapshotFormatRequest): ResolvedConfig {
	if (config.snapshotFormat?.printBasicPrototype !== undefined) {
		return config;
	}

	const mappings = resolveAllTsconfigMappings({
		cache,
		fileSystem,
		projectRoot: config.rootDir,
		tsconfigReader,
	});
	return {
		...config,
		snapshotFormat: {
			...config.snapshotFormat,
			printBasicPrototype: isLuauProject(testFiles, mappings),
		},
	};
}
