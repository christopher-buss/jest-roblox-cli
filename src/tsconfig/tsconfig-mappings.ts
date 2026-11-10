import { getTsconfig } from "get-tsconfig";
import * as path from "node:path";

import { isTsSource } from "../utils/extensions.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";

/** The source and output roots of one tsconfig. */
export interface TsconfigMapping {
	/** The compiled output root. */
	outDir: string;
	/** The TypeScript source root. */
	rootDir: string;
}

/** The `compilerOptions` fields the executor reads. */
interface TsconfigCompilerOptions {
	/** Compiled-output directory. */
	outDir?: string;
	/** Source root directory; `null` clears an inherited value. */
	rootDir?: null | string;
	/** Source roots merged into one virtual directory. */
	rootDirs?: Array<string>;
}

const TSCONFIG_FILENAME = /^tsconfig.*\.json$/i;

/** How a tsconfig is located and parsed. */
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

/** Mappings keyed by the `rootDir` they were read from; one per pass. */
export type TsconfigMappingCache = Map<string, Array<TsconfigMapping>>;

/** Inputs for `resolveAllTsconfigMappings`. */
export interface ResolveAllTsconfigMappingsOptions {
	/** Cache shared across one pass, if any. */
	cache?: TsconfigMappingCache | undefined;
	/** File system to scan; defaults to Node's. */
	fileSystem: FileSystem;
	/** Project root to scan for tsconfigs. */
	projectRoot: string;
	/** Reader for tsconfig files; defaults to the real reader. */
	tsconfigReader: TsconfigReader;
}

/** Inputs for {@link findMapping}. */
export interface FindMappingOptions {
	/** Which root to match the path against; defaults to `outDir`. */
	readonly key?: "outDir" | "rootDir";
	/** The path to find a mapping for. */
	readonly filePath: string;
	/** The candidate mappings. */
	readonly mappings: ReadonlyArray<TsconfigMapping>;
}

/** Inputs for {@link replacePrefix}. */
export interface ReplacePrefixOptions {
	/** The path to rewrite. */
	readonly filePath: string;
	/** The directory prefix to remove. */
	readonly from: string;
	/** The directory prefix to put in its place. */
	readonly to: string;
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
 * Scan a project root for tsconfig mappings, through the cache if given.
 * @param options - Project root, cache, file system and reader.
 * @returns The mappings for the project root.
 */
export function resolveAllTsconfigMappings({
	cache,
	fileSystem,
	projectRoot,
	tsconfigReader,
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
 * @returns The directories, or both undefined without local compiler options.
 */
export function resolveTsconfigDirectories(
	projectRoot: string,
	tsconfigReader: TsconfigReader,
): TsconfigDirectories {
	// tsconfig.json may hold a type-check outDir such as out-tsc/.
	const tsconfig =
		tsconfigReader(projectRoot, "tsconfig.lib.json") ?? tsconfigReader(projectRoot);

	// getTsconfig walks up into parent directories.
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

/**
 * Find the mapping whose root contains a path, preferring the longest root.
 * @param options - The path, the mappings and which root to match.
 * @returns The best mapping, or `undefined` when none contains the path.
 */
export function findMapping({
	key = "outDir",
	filePath,
	mappings,
}: FindMappingOptions): TsconfigMapping | undefined {
	let best: TsconfigMapping | undefined;
	let bestLength = -1;

	for (const mapping of mappings) {
		const prefix = mapping[key];
		const isMatch = filePath === prefix || filePath.startsWith(`${prefix}/`);

		if (isMatch && prefix.length > bestLength) {
			best = mapping;
			bestLength = prefix.length;
		}
	}

	return best;
}

/**
 * Move a path from one directory prefix to another.
 * @param options - The path and the two prefixes.
 * @returns The rewritten path, or the input when it is not under `from`.
 */
export function replacePrefix({ filePath, from, to }: ReplacePrefixOptions): string {
	if (filePath === from) {
		return to;
	}

	// The resolver strips the leading "./", so match a bare relative path too.
	if (from === ".") {
		const rest = filePath.startsWith("./") ? filePath.slice(2) : filePath;
		return `${to}/${rest}`;
	}

	if (filePath.startsWith(`${from}/`)) {
		return `${to}${filePath.slice(from.length)}`;
	}

	return filePath;
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

	mappings.sort((a, b) => b.outDir.length - a.outDir.length);

	return mappings;
}
