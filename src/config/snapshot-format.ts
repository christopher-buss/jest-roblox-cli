import type { TsconfigMappingCache } from "../executor/tsconfig-mappings.ts";
import { isLuauProject, resolveAllTsconfigMappings } from "../executor/tsconfig-mappings.ts";
import type { ResolvedConfig } from "./schema.ts";

/**
 * Resolve the snapshot format a project runs under: `printBasicPrototype`
 * follows the project's language, because Jest-Roblox prints `Table {` where
 * JS Jest prints `{`. Idempotent — a config that already carries the flag
 * (user-declared, or resolved by an earlier caller) comes back untouched.
 */
export function resolveSnapshotFormat(
	config: ResolvedConfig,
	testFiles: ReadonlyArray<string>,
	cache: TsconfigMappingCache,
): ResolvedConfig {
	if (config.snapshotFormat?.printBasicPrototype !== undefined) {
		return config;
	}

	const mappings = resolveAllTsconfigMappings(config.rootDir, cache);
	return {
		...config,
		snapshotFormat: {
			...config.snapshotFormat,
			printBasicPrototype: isLuauProject(testFiles, mappings),
		},
	};
}
