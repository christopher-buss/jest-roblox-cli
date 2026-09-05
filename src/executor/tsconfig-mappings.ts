import { type } from "arktype";
import { getTsconfig } from "get-tsconfig";
import * as path from "node:path";

import { executorTsconfigSchema, type TsconfigCompilerOptions } from "../config/tsconfig-schema.ts";
import type { TsconfigMapping } from "../types/tsconfig.ts";
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

export interface TsconfigDirectories {
	outDir: string | undefined;
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

export function createTsconfigMappingCache(): TsconfigMappingCache {
	return new Map();
}

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

export function readTsconfigMapping(
	tsconfigPath: string,
	fileSystem: FileSystem = nodeFileSystem,
): TsconfigDirectories | undefined {
	try {
		const raw = executorTsconfigSchema(
			JSON.parse(fileSystem.readFileSync(tsconfigPath, "utf-8")),
		);
		if (raw instanceof type.errors || raw.compilerOptions === undefined) {
			return undefined;
		}

		const mappings = parseTsconfigMappings(raw.compilerOptions);
		return mappings[0];
	} catch {
		return undefined;
	}
}

export function resolveAllTsconfigMappings(
	projectRoot: string,
	cache?: TsconfigMappingCache,
	fileSystem: FileSystem = nodeFileSystem,
	tsconfigReader: TsconfigReader = nodeTsconfigReader,
): Array<TsconfigMapping> {
	const resolvedRoot = path.resolve(projectRoot);
	const cached = cache?.get(resolvedRoot);
	if (cached !== undefined) {
		return cached;
	}

	const mappings = scanTsconfigMappings(fileSystem, resolvedRoot, tsconfigReader);
	cache?.set(resolvedRoot, mappings);
	return mappings;
}

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

function parseTsconfigMappings(options: TsconfigCompilerOptions): Array<TsconfigMapping> {
	const outDirectory = normalizeDirectoryPath(options.outDir ?? "out");

	if (options.rootDirs !== undefined && options.rootDirs.length > 0) {
		// rootDirs creates a virtual merged root. Output preserves directory
		// names relative to their common ancestor. Compute the common ancestor
		// as the effective rootDir.
		const normalized = options.rootDirs.map((directory) => normalizeDirectoryPath(directory));
		const commonAncestor = normalized.reduce((ancestor, directory) => {
			const parts = ancestor.split("/");
			const directoryParts = directory.split("/");
			let common = 0;
			while (
				common < parts.length &&
				common < directoryParts.length &&
				parts[common] === directoryParts[common]
			) {
				common++;
			}

			return parts.slice(0, common).join("/");
		});
		return [{ outDir: outDirectory, rootDir: commonAncestor || "." }];
	}

	if (options.rootDir === null) {
		return [];
	}

	return [{ outDir: outDirectory, rootDir: normalizeDirectoryPath(options.rootDir ?? "src") }];
}

function scanTsconfigMappings(
	fileSystem: FileSystem,
	resolvedRoot: string,
	tsconfigReader: TsconfigReader,
): Array<TsconfigMapping> {
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
		if (compilerOptions?.outDir === undefined) {
			continue;
		}

		const parsed = parseTsconfigMappings(compilerOptions);
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
