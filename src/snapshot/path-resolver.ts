import type { RojoProject, RojoTreeNode } from "../types/rojo.ts";
import type { TsconfigMapping } from "../types/tsconfig.ts";
import { findMapping, replacePrefix } from "../utils/tsconfig-mapping.ts";

export interface ResolvedSnapshotPath {
	filePath: string;
	mapping?: TsconfigMapping;
}

export interface SnapshotPathResolver {
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
			const normalized = virtualPath.replaceAll("\\", "/");

			for (const [prefix, basePath] of rojoMappings) {
				if (!normalized.startsWith(`${prefix}/`) && normalized !== prefix) {
					continue;
				}

				const suffix = normalized.slice(prefix.length + 1);
				const result = `${basePath}/${suffix}`;

				const mapping = findMapping(result, tsconfigMappings);
				if (mapping !== undefined) {
					const replaced = replacePrefix(result, mapping.outDir, mapping.rootDir);
					return { filePath: replaced.replace(/^\.\//, ""), mapping };
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
		if (key.startsWith("$") || typeof value !== "object") {
			continue;
		}

		const dataModelPath = prefix ? `${prefix}/${key}` : key;
		const node = value as RojoTreeNode;

		if (typeof node.$path === "string") {
			mappings.push([dataModelPath, node.$path]);
		}

		mappings.push(...buildMappings(node, dataModelPath));
	}

	// Longest prefix first for greedy matching
	mappings.sort((a, b) => b[0].length - a[0].length);

	return mappings;
}
