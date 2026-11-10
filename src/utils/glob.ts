import * as path from "node:path";
import process from "node:process";

import type { FileSystem } from "./file-system.ts";
import { normalizeWindowsPath } from "./normalize-windows-path.ts";

const LEADING_CURRENT_DIRECTORY = /^\.\//;

/** Directory walks already done, keyed by the directory walked. */
export interface GlobCache {
	/** Trailing segments the declared patterns match; `undefined` for any. */
	readonly leaves: ReadonlySet<string> | undefined;
	/** Kept files per walked directory. */
	readonly walks: Map<string, Array<string>>;
}

interface GlobOptions {
	cache?: GlobCache | undefined;
	cwd?: string;
	fileSystem: FileSystem;
}

interface WalkDirectoryOptions {
	readonly baseDirectory: string;
	readonly directoryPath: string;
	readonly fileSystem: FileSystem;
	readonly keepBasename: ((basename: string) => boolean) | undefined;
}

/**
 * A cache for the patterns given, or for any pattern when none are.
 * @param patterns - Every pattern the cache will serve, or none for any.
 * @returns An empty cache that keeps only files those patterns can match.
 */
export function createGlobCache(patterns?: Iterable<string>): GlobCache {
	return { leaves: collectLeaves(patterns), walks: new Map<string, Array<string>>() };
}

/**
 * Whether a path matches a glob, where `*` stays inside one segment and `**`
 * spans them.
 * @param filePath - The `/`-separated path to test.
 * @param pattern - The glob to match against.
 * @returns True when the whole path matches.
 */
export function matchesGlobPattern(filePath: string, pattern: string): boolean {
	return compileGlobPattern(pattern).test(filePath);
}

/**
 * Find the files under `cwd` that match a glob.
 * @param pattern - The glob, relative to `cwd`.
 * @param options - The directory, filesystem and shared walk cache.
 * @returns The matching paths, relative to `cwd`.
 */
export function globSync(pattern: string, options: GlobOptions): Array<string> {
	const { fileSystem } = options;
	const cwd = options.cwd ?? process.cwd();
	const cache = servingCache(options.cache, pattern);

	let allFiles = cache?.walks.get(cwd);
	if (allFiles === undefined) {
		// A shared walk must keep what later patterns need, not this leaf.
		const leaves = cache === undefined ? leafOf(pattern) : cache.leaves;
		allFiles = walkDirectory({
			baseDirectory: cwd,
			directoryPath: cwd,
			fileSystem,
			keepBasename: compileLeafMatcher(leaves),
		});
		cache?.walks.set(cwd, allFiles);
	}

	const matcher = compileGlobPattern(pattern);
	return allFiles.filter((file) => matcher.test(file));
}

function leafOf(pattern: string): string | undefined {
	const leaf = pattern.slice(pattern.lastIndexOf("/") + 1);
	return leaf.includes("**") ? undefined : leaf;
}

function collectLeaves(patterns?: Iterable<string>): ReadonlySet<string> | undefined {
	if (patterns === undefined) {
		return undefined;
	}

	const leaves = new Set<string>();
	for (const pattern of patterns) {
		const leaf = leafOf(pattern);
		if (leaf === undefined) {
			return undefined;
		}

		leaves.add(leaf);
	}

	return leaves;
}

function compileGlobPattern(pattern: string): RegExp {
	const regexPattern = pattern
		.replace(LEADING_CURRENT_DIRECTORY, "")
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		// Park `**` tokens before the single-star pass, which would rewrite the
		// `*` inside their expansions.
		.replace(/\*\*\//g, "{{DOUBLESTAR_SLASH}}")
		.replace(/\*\*/g, "{{DOUBLESTAR}}")
		.replace(/\*/g, "[^/]*")
		.replace(/\{\{DOUBLESTAR_SLASH\}\}/g, "(.+/)?")
		.replace(/\{\{DOUBLESTAR\}\}/g, ".*");

	return new RegExp(`^${regexPattern}$`);
}

function servingCache(cache: GlobCache | undefined, pattern: string): GlobCache | undefined {
	if (cache?.leaves === undefined) {
		return cache;
	}

	const leaf = leafOf(pattern);
	return leaf !== undefined && cache.leaves.has(leaf) ? cache : undefined;
}

function compileLeafMatcher(
	leaves: ReadonlySet<string> | string | undefined,
): ((basename: string) => boolean) | undefined {
	if (leaves === undefined) {
		return undefined;
	}

	const patterns = typeof leaves === "string" ? [leaves] : [...leaves];
	const matchers = patterns.map((leaf) => compileGlobPattern(leaf));
	return (basename) => matchers.some((matcher) => matcher.test(basename));
}

function walkDirectory({
	baseDirectory,
	directoryPath,
	fileSystem,
	keepBasename,
}: WalkDirectoryOptions): Array<string> {
	const results: Array<string> = [];

	try {
		const entries = fileSystem.readdirSync(directoryPath, { withFileTypes: true });

		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
					const fullPath = path.join(directoryPath, entry.name);
					results.push(
						...walkDirectory({
							baseDirectory,
							directoryPath: fullPath,
							fileSystem,
							keepBasename,
						}),
					);
				}
			} else if (keepBasename?.(entry.name) !== false) {
				const fullPath = path.join(directoryPath, entry.name);
				results.push(normalizeWindowsPath(path.relative(baseDirectory, fullPath)));
			}
		}
	} catch {
		// Ignore permission errors
	}

	return results;
}
