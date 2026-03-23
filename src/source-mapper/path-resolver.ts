import { existsSync } from "node:fs";

import type { RojoProject, RojoTreeNode } from "../types/rojo.ts";
import type { TsconfigMapping } from "../types/tsconfig.ts";
import { findMapping, replacePrefix } from "../utils/tsconfig-mapping.ts";

export interface ResolvedPath {
	filePath: string;
	mapping?: TsconfigMapping;
}

interface PathResolver {
	resolve(dataModelPath: string): ResolvedPath | undefined;
}

interface PathResolverConfig {
	mappings?: ReadonlyArray<TsconfigMapping>;
}

export function createPathResolver(
	rojoProject: RojoProject,
	config?: PathResolverConfig,
): PathResolver {
	const rojoMappings = new Map<string, string>();

	function walkTree(tree: RojoTreeNode, prefix: string): void {
		for (const [key, value] of Object.entries(tree)) {
			if (key.startsWith("$") || typeof value !== "object") {
				continue;
			}

			const dataModelPath = prefix ? `${prefix}.${key}` : key;
			const node = value as RojoTreeNode;

			if (typeof node.$path === "string") {
				rojoMappings.set(dataModelPath, node.$path);
			}

			walkTree(node, dataModelPath);
		}
	}

	walkTree(rojoProject.tree, "");

	const tsconfigMappings = config?.mappings ?? [];
	const sortedRojoMappings = [...rojoMappings.entries()].sort(([a], [b]) => b.length - a.length);

	return {
		resolve(dataModelPath: string): ResolvedPath | undefined {
			for (const [prefix, basePath] of sortedRojoMappings) {
				if (dataModelPath !== prefix && !dataModelPath.startsWith(`${prefix}.`)) {
					continue;
				}

				const suffix = dataModelPath.slice(prefix.length + 1);
				const filePath = convertToFilePath(suffix);
				const result = `${basePath}/${filePath}`;

				const mapping = findMapping(result, tsconfigMappings);
				if (mapping !== undefined) {
					const mapped = replacePrefix(result, mapping.outDir, mapping.rootDir).replace(
						/^\.\//,
						"",
					);
					return { filePath: `${luauInitToIndex(mapped)}.ts`, mapping };
				}

				return { filePath: findLuaFile(result) };
			}

			return undefined;
		},
	};
}

function convertToFilePath(suffix: string): string {
	const parts = suffix.split(".");
	const result: Array<string> = [];

	for (let index = 0; index < parts.length; index++) {
		// eslint-disable-next-line ts/no-non-null-assertion -- Loop
		const part = parts[index]!;
		const nextPart = parts[index + 1];

		// Only combine with spec/test if it's the last part (filename suffix)
		if ((nextPart === "spec" || nextPart === "test") && index + 2 === parts.length) {
			result.push(`${part}.${nextPart}`);
			index++;
		} else {
			result.push(part);
		}
	}

	return result.join("/");
}

/** roblox-ts compiles index.ts → init.luau; reverse the rename for TS paths. */
function luauInitToIndex(filePath: string): string {
	return filePath.replace(/(^|\/)(init)(\.|\/)/, "$1index$3");
}

function findLuaFile(basePath: string): string {
	const luauPath = `${basePath}.luau`;
	if (existsSync(luauPath)) {
		return luauPath;
	}

	const luaPath = `${basePath}.lua`;
	if (existsSync(luaPath)) {
		return luaPath;
	}

	return luauPath;
}
