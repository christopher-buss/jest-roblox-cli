import { getTsconfig } from "get-tsconfig";
import * as path from "node:path";

import type { TsconfigCompilerOptions, TsconfigMapping } from "../types/tsconfig-types.ts";
import { isTsSource } from "../utils/extensions.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";

const TSCONFIG_FILENAME = /^tsconfig.*\.json$/i;

/**
 * How a tsconfig is located and parsed, named once so every caller takes it as
 * a parameter rather than importing `get-tsconfig` itself.
 *
 * Same reason as `FileSystem` in `../utils/file-system.ts`: `get-tsconfig` is
 * an externalized dependency that reads through a `node:fs` binding of its
 * own, and `vi.mock` of one holds only while no earlier file in the same worker
 * evaluated it unmocked — a guarantee Vitest gives with process isolation and
 * takes away without it.
 */
export type TsconfigReader = typeof getTsconfig;

/** The real reader, and the only one production ever uses. */
export const nodeTsconfigReader: TsconfigReader = getTsconfig;

/** The output and source directories one tsconfig declares. */
export interface TsconfigDirectories {
	/** Compiled output directory, if known. */
	outDir: string | undefined;
	/** Source root directory, if known. */
	rootDir: string | undefined;
}

/**
 * Mappings keyed by the `rootDir` they were read from. Reading them is a
 * directory scan plus a parse per tsconfig, and every project in a package
 * shares one `rootDir` — a cache collapses a pass over N projects into one
 * scan per package. Each pass owns its cache (the workspace payload build and
 * the run each hold one), so a scan per package outlives no pass and no caller
 * has to reason about staleness across a run.
 */
export type TsconfigMappingCache = Map<string, Array<TsconfigMapping>>;

/** Inputs for `resolveAllTsconfigMappings`. */
export interface ResolveAllTsconfigMappingsOptions {
	/** Cache shared across one pass, if any. */
	cache?: TsconfigMappingCache | undefined;
	/** File system to scan; defaults to Node's. */
	fileSystem?: FileSystem | undefined;
	/** Project root to scan for tsconfigs. */
	projectRoot: string;
	/** Reader for tsconfig files; defaults to the real reader. */
	tsconfigReader?: TsconfigReader | undefined;
}

/**
 * Create an empty mapping cache.
 * @returns A new, empty cache.
 */
export function createTsconfigMappingCache(): TsconfigMappingCache {
	return new Map();
}

/**
 * Tell whether a project is plain Luau.
 * @param testFiles - Paths of the project's tests.
 * @param tsconfigMappings - Mappings found for the project root.
 * @returns True when there are no mappings and no TypeScript test file.
 */
export function isLuauProject(
	testFiles: ReadonlyArray<string>,
	tsconfigMappings: ReadonlyArray<TsconfigMapping>,
): boolean {
	if (tsconfigMappings.length > 0) {
		return false;
	}

	if (testFiles.some((file) => isTsSource(file))) {
		return false;
	}

	return true;
}

/**
 * Scan a project root for tsconfig mappings, through the cache when one is given.
 * @param options - Project root, cache, file system and reader.
 * @returns The mappings for the project root.
 */
export function resolveAllTsconfigMappings({
	cache,
	fileSystem = nodeFileSystem,
	projectRoot,
	tsconfigReader = nodeTsconfigReader,
}: ResolveAllTsconfigMappingsOptions): Array<TsconfigMapping> {
	const resolvedRoot = path.resolve(projectRoot);
	const cached = cache?.get(resolvedRoot);
	if (cached !== undefined) {
		return cached;
	}

	const mappings = scanTsconfigMappings({ fileSystem, resolvedRoot, tsconfigReader });
	cache?.set(resolvedRoot, mappings);
	return mappings;
}

/**
 * Resolve the project's out and root directories from its local tsconfig.
 * @param projectRoot - Project root to read from.
 * @param tsconfigReader - Reader for tsconfig files.
 * @returns The directories, or both undefined when no local tsconfig has compiler options.
 */
export function resolveTsconfigDirectories(
	projectRoot: string,
	tsconfigReader: TsconfigReader = nodeTsconfigReader,
): TsconfigDirectories {
	// Prefer tsconfig.lib.json (roblox-ts compilation config with correct outDir)
	// over tsconfig.json (which may point to type-checking outDir like out-tsc/)
	const tsconfig =
		tsconfigReader(projectRoot, "tsconfig.lib.json") ?? tsconfigReader(projectRoot);

	// Only use tsconfig if it lives within the project root — ignore
	// parent-directory tsconfigs that getTsconfig walks up to find.
	const tsconfigDirectory =
		tsconfig !== null ? path.dirname(path.resolve(tsconfig.path)) : undefined;
	const resolvedRoot = path.resolve(projectRoot);
	const relativeTsconfigDirectory =
		tsconfigDirectory === undefined
			? undefined
			: path.relative(resolvedRoot, tsconfigDirectory);
	const isLocal =
		relativeTsconfigDirectory !== undefined &&
		!relativeTsconfigDirectory.startsWith("..") &&
		!path.isAbsolute(relativeTsconfigDirectory);

	if (!isLocal || tsconfig?.config.compilerOptions === undefined) {
		return { outDir: undefined, rootDir: undefined };
	}

	const outDirectory = tsconfig.config.compilerOptions.outDir ?? "out";
	const rootDirectory = tsconfig.config.compilerOptions.rootDir ?? "src";

	return {
		outDir: normalizeDirectoryPath(outDirectory),
		rootDir: normalizeDirectoryPath(rootDirectory),
	};
}

function normalizeDirectoryPath(directory: string): string {
	return normalizeWindowsPath(path.normalize(directory));
}

function parseTsconfigMappings(
	options: TsconfigCompilerOptions,
	declaredOutDirectory: string,
): Array<TsconfigMapping> {
	const outDirectory = normalizeDirectoryPath(declaredOutDirectory);

	if (options.rootDirs !== undefined && options.rootDirs.length > 0) {
		// rootDirs creates a virtual merged root. Output preserves directory
		// names relative to their common ancestor. Compute the common ancestor
		// as the effective rootDir.
		const normalized = options.rootDirs.map((directory) => normalizeDirectoryPath(directory));
		const commonAncestor = normalized.reduce((ancestor, directory) => {
			const parts = ancestor.split("/");
			const directoryParts = directory.split("/");
			const common: Array<string> = [];
			for (const [index, part] of parts.entries()) {
				if (part !== directoryParts[index]) {
					break;
				}

				common.push(part);
			}

			return common.join("/");
		});
		return [{ outDir: outDirectory, rootDir: commonAncestor || "." }];
	}

	if (options.rootDir === null) {
		return [];
	}

	return [{ outDir: outDirectory, rootDir: normalizeDirectoryPath(options.rootDir ?? "src") }];
}

function scanTsconfigMappings({
	fileSystem,
	resolvedRoot,
	tsconfigReader,
}: {
	fileSystem: FileSystem;
	resolvedRoot: string;
	tsconfigReader: TsconfigReader;
}): Array<TsconfigMapping> {
	let files: Array<string>;
	try {
		files = fileSystem.readdirSync(resolvedRoot).filter((file) => TSCONFIG_FILENAME.test(file));
	} catch {
		return [];
	}

	const seen = new Set<string>();
	const mappings: Array<TsconfigMapping> = [];

	for (const file of files) {
		const tsconfig = tsconfigReader(resolvedRoot, file);
		const compilerOptions = tsconfig?.config.compilerOptions;
		const outDirectory = compilerOptions?.outDir;
		if (compilerOptions === undefined || outDirectory === undefined) {
			continue;
		}

		const parsed = parseTsconfigMappings(compilerOptions, outDirectory);
		for (const entry of parsed) {
			const key = `${entry.outDir}:${entry.rootDir}`;
			if (!seen.has(key)) {
				seen.add(key);
				mappings.push(entry);
			}
		}
	}

	// Longest outDir first for correct prefix matching
	mappings.sort((a, b) => b.outDir.length - a.outDir.length);

	return mappings;
}
