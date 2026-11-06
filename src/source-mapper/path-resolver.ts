import type { RojoProject } from "../types/rojo.ts";
import { listDataModelMounts } from "../types/rojo.ts";
import type { TsconfigMapping } from "../types/tsconfig-types.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { resolveFromDirectory } from "../utils/normalize-windows-path.ts";
import { findMapping, replacePrefix } from "../utils/tsconfig-mapping.ts";

const INIT_SEGMENT = /(^|\/)(init)(\.|\/)/;
const LEADING_DOT_SLASH = /^\.\//;
const LUA_EXTENSION = /\.luau?$/;
const TS_EXTENSION = /\.ts$/;

/** Maps DataModel paths to the files on disk that produced them. */
export interface PathResolver {
	/** Probes disk (`.luau` then `.lua`) for paths with no tsconfig mapping. */
	resolve(dataModelPath: string): ResolvedPath | undefined;
}

interface ResolvedPath {
	filePath: string;
	luauPath: string;
	mapping?: TsconfigMapping;
}

interface PathResolverConfig {
	/** Where an unmapped path is probed. Defaults to the real filesystem. */
	fileSystem?: FileSystem;
	mappings?: ReadonlyArray<TsconfigMapping>;
	/** Folder relative mounts resolve in; without it, paths stay relative. */
	rootDirectory?: string | undefined;
}

/**
 * The roblox-ts compiler turns index.ts into init.luau; reverse the rename.
 * @param filePath - A resolved file path.
 * @returns The path with an `init` segment renamed to `index`.
 */
export function luauInitToIndex(filePath: string): string {
	return filePath.replace(INIT_SEGMENT, "$1index$3");
}

/**
 * Build a resolver from a Rojo project and tsconfig mappings.
 * @param rojoProject - The Rojo project whose tree places files.
 * @param config - The mappings and the filesystem to probe.
 * @param config.fileSystem - Where unmapped paths are probed.
 * @param config.mappings - The tsconfig roots to map through.
 * @param config.rootDirectory - Directory relative mounts resolve in.
 * @returns A resolver over the Rojo tree and tsconfig roots.
 */
export function createPathResolver(
	rojoProject: RojoProject,
	{ fileSystem = nodeFileSystem, mappings, rootDirectory }: PathResolverConfig = {},
): PathResolver {
	const rojoMappings = new Map(listDataModelMounts(rojoProject.tree, "."));

	const tsconfigMappings = mappings ?? [];
	const sortedRojoMappings = [...rojoMappings].sort(([a], [b]) => b.length - a.length);

	return {
		resolve(dataModelPath: string): ResolvedPath | undefined {
			for (const [prefix, basePath] of sortedRojoMappings) {
				if (dataModelPath !== prefix && !dataModelPath.startsWith(`${prefix}.`)) {
					continue;
				}

				const suffix = dataModelPath.slice(prefix.length + 1);
				const result =
					suffix === "" ? basePath : `${basePath}/${convertToFilePath(suffix)}`;

				return resolveMountedPath(result, {
					fileSystem,
					mappings: tsconfigMappings,
					rootDirectory,
				});
			}

			return undefined;
		},
	};
}

function mapTypeScriptPath(filePath: string, mapping: TsconfigMapping): string {
	const mapped = replacePrefix({ filePath, from: mapping.outDir, to: mapping.rootDir })
		.replace(LEADING_DOT_SLASH, "")
		.replace(LUA_EXTENSION, "");
	return luauInitToIndex(`${mapped}.ts`);
}

function toDisk(rootDirectory: string | undefined, filePath: string): string {
	return rootDirectory === undefined ? filePath : resolveFromDirectory(rootDirectory, filePath);
}

function toLuauPath(tsPath: string, mapping: TsconfigMapping): string {
	return replacePrefix({ filePath: tsPath, from: mapping.rootDir, to: mapping.outDir }).replace(
		TS_EXTENSION,
		".luau",
	);
}

function findLuaFile(fileSystem: FileSystem, basePath: string): string {
	if (LUA_EXTENSION.test(basePath)) {
		return basePath;
	}

	const luauPath = `${basePath}.luau`;
	if (fileSystem.existsSync(luauPath)) {
		return luauPath;
	}

	const luaPath = `${basePath}.lua`;
	if (fileSystem.existsSync(luaPath)) {
		return luaPath;
	}

	return luauPath;
}

function resolveMountedPath(
	mountedPath: string,
	{
		fileSystem,
		mappings,
		rootDirectory,
	}: Pick<PathResolverConfig, "rootDirectory"> &
		Required<Pick<PathResolverConfig, "fileSystem" | "mappings">>,
): ResolvedPath {
	const mapping = findMapping({ filePath: mountedPath, mappings });
	if (mapping !== undefined) {
		const tsPath = mapTypeScriptPath(mountedPath, mapping);
		return {
			filePath: toDisk(rootDirectory, tsPath),
			luauPath: toDisk(rootDirectory, toLuauPath(tsPath, mapping)),
			mapping,
		};
	}

	const luauPath = findLuaFile(fileSystem, toDisk(rootDirectory, mountedPath));
	return { filePath: luauPath, luauPath };
}

function convertToFilePath(suffix: string): string {
	const parts = suffix.split(".");
	const result: Array<string> = [];

	for (let index = 0; index < parts.length; index++) {
		// oxlint-disable-next-line typescript/no-non-null-assertion -- Loop
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
