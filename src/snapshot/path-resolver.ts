import type { RojoProject, RojoTreeNode } from "../types/rojo.ts";
import { listDataModelMounts } from "../types/rojo.ts";
import type { TsconfigMapping } from "../types/tsconfig-types.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { findMapping, replacePrefix } from "../utils/tsconfig-mapping.ts";

interface ResolvedSnapshotPath {
	filePath: string;
	mapping?: TsconfigMapping;
}

interface SnapshotPathResolver {
	resolve(virtualPath: string): ResolvedSnapshotPath | undefined;
}

interface SnapshotPathResolverConfig {
	mappings?: ReadonlyArray<TsconfigMapping>;
	rojoProject: RojoProject;
}

/**
 * Map a DataModel snapshot path to the `$path` mount it sits under, then from
 * `outDir` to `rootDir` when a tsconfig mapping covers it.
 * @param config - Rojo project and optional tsconfig mappings.
 * @returns A resolver that answers `undefined` for a path no mount covers.
 */
export function createSnapshotPathResolver(
	config: SnapshotPathResolverConfig,
): SnapshotPathResolver {
	const rojoMappings = buildMappings(config.rojoProject.tree);
	const tsconfigMappings = config.mappings ?? [];

	return {
		resolve(virtualPath: string): ResolvedSnapshotPath | undefined {
			// Normalize separators — getParent in RobloxShared uses \ for
			// non-unix paths
			const normalized = normalizeWindowsPath(virtualPath);

			for (const [prefix, basePath] of rojoMappings) {
				if (normalized !== prefix && !normalized.startsWith(`${prefix}/`)) {
					continue;
				}

				const suffix = normalized.slice(prefix.length);
				const result = `${basePath}${suffix}`;

				const mapping = findMapping({ filePath: result, mappings: tsconfigMappings });
				if (mapping !== undefined) {
					return {
						filePath: replacePrefix({
							filePath: result,
							from: mapping.outDir,
							to: mapping.rootDir,
						}),
						mapping,
					};
				}

				return { filePath: result };
			}

			return undefined;
		},
	};
}

function buildMappings(tree: RojoTreeNode): Array<[string, string]> {
	const mappings = listDataModelMounts(tree, "/");

	// Longest prefix first for greedy matching
	mappings.sort((a, b) => b[0].length - a[0].length);

	return mappings;
}
