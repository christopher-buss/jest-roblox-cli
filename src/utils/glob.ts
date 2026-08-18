import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";

import { normalizeWindowsPath } from "./normalize-windows-path.ts";

/**
 * Directory walks already done, keyed by the directory walked. Hand the same
 * cache to a run of `globSync` calls that share a `cwd` and it walks once
 * instead of once per pattern.
 */
export type GlobCache = Map<string, Array<string>>;

interface GlobOptions {
	/**
	 * Reuse walks across calls. Caller-owned on purpose: a cache is only
	 * sound while nothing writes to `cwd`, and the caller is the one that
	 * knows how long that holds. Omit it and every call walks fresh.
	 */
	cache?: GlobCache | undefined;
	cwd?: string;
}

export function createGlobCache(): GlobCache {
	return new Map<string, Array<string>>();
}

export function matchesGlobPattern(filePath: string, pattern: string): boolean {
	return compileGlobPattern(pattern).test(filePath);
}

export function globSync(pattern: string, options: GlobOptions = {}): Array<string> {
	const cwd = options.cwd ?? process.cwd();

	let allFiles = options.cache?.get(cwd);
	if (allFiles === undefined) {
		allFiles = walkDirectory(cwd, cwd);
		options.cache?.set(cwd, allFiles);
	}

	const matcher = compileGlobPattern(pattern);
	return allFiles.filter((file) => matcher.test(file));
}

/**
 * Translate one glob into the regex that matches it. Separate from
 * {@link matchesGlobPattern} so a caller testing many paths against one pattern
 * compiles once rather than once per path.
 */
function compileGlobPattern(pattern: string): RegExp {
	const regexPattern = pattern
		// Escape regex metacharacters (incl. `.`) so they match literally; the
		// glob wildcards `*`/`**` are translated below and are left untouched.
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*\//g, "{{DOUBLESTAR_SLASH}}")
		.replace(/\*\*/g, ".*")
		.replace(/\*/g, "[^/]*")
		.replace(/\{\{DOUBLESTAR_SLASH\}\}/g, "(.+/)?");

	return new RegExp(`^${regexPattern}$`);
}

function walkDirectory(directoryPath: string, baseDirectory: string): Array<string> {
	const results: Array<string> = [];

	try {
		const entries = fs.readdirSync(directoryPath, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = path.join(directoryPath, entry.name);
			const relativePath = normalizeWindowsPath(path.relative(baseDirectory, fullPath));

			if (entry.isDirectory()) {
				if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
					results.push(...walkDirectory(fullPath, baseDirectory));
				}
			} else {
				results.push(relativePath);
			}
		}
	} catch {
		// Ignore permission errors
	}

	return results;
}
