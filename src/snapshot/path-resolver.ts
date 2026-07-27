import type { RojoProject, RojoTreeNode } from "../types/rojo.ts";
import type { TsconfigMapping } from "../types/tsconfig.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { isRojoTreeNode } from "../utils/rojo-tree-node.ts";
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

export function createSnapshotPathResolver(
	config: SnapshotPathResolverConfig,
): SnapshotPathResolver {
	const rojoMappings = buildMappings(config.rojoProject.tree, "");
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

				const suffix = normalized.slice(prefix.length + 1);
				const result = `${basePath}/${suffix}`;

				const mapping = findMapping(result, tsconfigMappings);
				if (mapping !== undefined) {
					return {
						filePath: replacePrefix(result, mapping.outDir, mapping.rootDir),
						mapping,
					};
				}

				return { filePath: result };
			}

			return undefined;
		},
	};
}

function buildMappings(tree: RojoTreeNode, prefix: string): Array<[string, string]> {
	const mappings: Array<[string, string]> = [];

	for (const [key, value] of Object.entries(tree)) {
		if (!isRojoTreeNode(value) || key.startsWith("$")) {
			continue;
		}

		const dataModelPath = prefix ? `${prefix}/${key}` : key;

		if (typeof value.$path === "string") {
			mappings.push([dataModelPath, value.$path]);
		}

		mappings.push(...buildMappings(value, dataModelPath));
	}

	// Longest prefix first for greedy matching
	mappings.sort((a, b) => b[0].length - a[0].length);

	return mappings;
}
