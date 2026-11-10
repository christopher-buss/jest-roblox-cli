import type { RojoProject } from "@isentinel/rojo-utils";
import { listMounts } from "@isentinel/rojo-utils";

import type { TsconfigMapping } from "../tsconfig/tsconfig-mappings.ts";
import { findMapping, replacePrefix } from "../tsconfig/tsconfig-mappings.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { normalizeWindowsPath, resolveFromDirectory } from "../utils/normalize-windows-path.ts";

const INIT_SEGMENT = /(^|\/)(init)(\.|\/)/;
const LEADING_DOT_SLASH = /^\.\//;
const LUA_EXTENSION = /\.luau?$/;
const TS_EXTENSION = /\.ts$/;

/** Maps DataModel paths to the files on disk that produced them. */
export interface PathResolver {
	/** Probes disk (`.luau` then `.lua`) for paths with no tsconfig mapping. */
	resolve(dataModelPath: string): ResolvedPath | undefined;
	/** Where a slash-separated snapshot path lands on disk. */
	resolveSnapshot(virtualPath: string): ResolvedSnapshotPath | undefined;
}

/** Disk locations of one snapshot file. */
interface ResolvedSnapshotPath {
	filePath: string;
	outPath?: string | undefined;
}

interface ResolvedPath {
	filePath: string;
	luauPath: string;
	mapping?: TsconfigMapping;
}

interface MappedPaths {
	mappings: ReadonlyArray<TsconfigMapping>;
	rootDirectory: string | undefined;
}

interface SegmentedMount {
	basePath: string;
	segments: Array<string>;
}

interface MountMatch {
	basePath: string;
	suffix: string;
}

interface PathResolverConfig {
	fileSystem: FileSystem;
	mappings?: ReadonlyArray<TsconfigMapping> | undefined;
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
	{ fileSystem, mappings = [], rootDirectory }: PathResolverConfig,
): PathResolver {
	const mounts = sortMounts(rojoProject);

	return {
		resolve(dataModelPath: string): ResolvedPath | undefined {
			const match = matchMount(mounts, { dataModelPath, separator: "." });
			if (match === undefined) {
				return undefined;
			}

			const { basePath, suffix } = match;
			const result = suffix === "" ? basePath : `${basePath}/${convertToFilePath(suffix)}`;
			return resolveMountedPath(result, { fileSystem, mappings, rootDirectory });
		},

		resolveSnapshot(virtualPath: string): ResolvedSnapshotPath | undefined {
			// getParent in RobloxShared joins with \ on non-unix paths.
			const match = matchMount(mounts, {
				dataModelPath: normalizeWindowsPath(virtualPath),
				separator: "/",
			});
			return match === undefined
				? undefined
				: resolveSnapshotPath(match, { mappings, rootDirectory });
		},
	};
}

function sortMounts(rojoProject: RojoProject): Array<SegmentedMount> {
	return listMounts(rojoProject.tree)
		.sort((a, b) => b.dataModelPath.length - a.dataModelPath.length)
		.map(({ dataModelPath, fsPath }) => {
			return { basePath: fsPath, segments: dataModelPath.split("/") };
		});
}

function matchMount(
	mounts: ReadonlyArray<SegmentedMount>,
	{ dataModelPath, separator }: { dataModelPath: string; separator: "." | "/" },
): MountMatch | undefined {
	for (const { basePath, segments } of mounts) {
		const prefix = segments.join(separator);
		if (dataModelPath === prefix || dataModelPath.startsWith(`${prefix}${separator}`)) {
			return { basePath, suffix: dataModelPath.slice(prefix.length + 1) };
		}
	}

	return undefined;
}

function toDisk(rootDirectory: string | undefined, filePath: string): string {
	return rootDirectory === undefined ? filePath : resolveFromDirectory(rootDirectory, filePath);
}

function resolveSnapshotPath(
	{ basePath, suffix }: MountMatch,
	{ mappings, rootDirectory }: MappedPaths,
): ResolvedSnapshotPath {
	const mounted = suffix === "" ? basePath : `${basePath}/${suffix}`;
	const mapping = findMapping({ filePath: mounted, mappings });
	if (mapping === undefined) {
		return { filePath: toDisk(rootDirectory, mounted) };
	}

	const source = replacePrefix({ filePath: mounted, from: mapping.outDir, to: mapping.rootDir });
	return { filePath: toDisk(rootDirectory, source), outPath: toDisk(rootDirectory, mounted) };
}

function mapTypeScriptPath(filePath: string, mapping: TsconfigMapping): string {
	const mapped = replacePrefix({ filePath, from: mapping.outDir, to: mapping.rootDir })
		.replace(LEADING_DOT_SLASH, "")
		.replace(LUA_EXTENSION, "");
	return luauInitToIndex(`${mapped}.ts`);
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
	{ fileSystem, mappings, rootDirectory }: MappedPaths & { fileSystem: FileSystem },
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

		if ((nextPart === "spec" || nextPart === "test") && index + 2 === parts.length) {
			result.push(`${part}.${nextPart}`);
			index++;
		} else {
			result.push(part);
		}
	}

	return result.join("/");
}
