import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";

import { normalizeWindowsPath } from "./normalize-windows-path.ts";

const LEADING_CURRENT_DIRECTORY = /^\.\//;

/**
 * Directory walks already done, keyed by the directory walked. Hand the same
 * cache to a run of `globSync` calls that share a `cwd` and it walks once
 * instead of once per pattern.
 */
export interface GlobCache {
	/**
	 * Trailing segments the declared patterns can match, or `undefined` when
	 * the cache serves any pattern. A walk keeps only the files whose basename
	 * one of these matches, so the cached array grows with the files a caller
	 * actually wants rather than with every file under `cwd`.
	 */
	readonly leaves: ReadonlySet<string> | undefined;
	/** Kept files per walked directory. */
	readonly walks: Map<string, Array<string>>;
}

interface GlobOptions {
	/**
	 * Reuse walks across calls. Caller-owned on purpose: a cache is only
	 * sound while nothing writes to `cwd`, and the caller is the one that
	 * knows how long that holds. Omit it and every call walks fresh.
	 */
	cache?: GlobCache | undefined;
	cwd?: string;
}

/**
 * A cache for the patterns given, or for any pattern when none are.
 *
 * Declaring them up front is what lets one walk stay one walk while still
 * discarding the files no pattern can match: the walk needs every caller's
 * trailing segment before it starts, and deriving the filter per call would
 * turn a shared cache back into a walk per distinct segment.
 *
 * A pattern the cache was not declared for is still answered correctly — it
 * walks fresh rather than reading a narrower cache — so an undeclared caller
 * loses the sharing, never the files.
 */
export function createGlobCache(patterns?: Iterable<string>): GlobCache {
	return { leaves: collectLeaves(patterns), walks: new Map<string, Array<string>>() };
}

export function matchesGlobPattern(filePath: string, pattern: string): boolean {
	return compileGlobPattern(pattern).test(filePath);
}

export function globSync(pattern: string, options: GlobOptions = {}): Array<string> {
	const cwd = options.cwd ?? process.cwd();
	const cache = servingCache(options.cache, pattern);

	let allFiles = cache?.walks.get(cwd);
	if (allFiles === undefined) {
		// A serving cache dictates the filter — including an undeclared cache's
		// "keep everything", which this pattern's own leaf must not narrow
		// while later patterns are still to read the same walk.
		const leaves = cache === undefined ? leafOf(pattern) : cache.leaves;
		allFiles = walkDirectory(cwd, cwd, compileLeafMatcher(leaves));
		cache?.walks.set(cwd, allFiles);
	}

	const matcher = compileGlobPattern(pattern);
	return allFiles.filter((file) => matcher.test(file));
}

/**
 * The pattern's trailing path segment, which every match's basename must
 * satisfy — `undefined` when the segment carries a `**` and so spans
 * separators, leaving the basename unconstrained.
 */
function leafOf(pattern: string): string | undefined {
	const leaf = pattern.slice(pattern.lastIndexOf("/") + 1);
	return leaf.includes("**") ? undefined : leaf;
}

/**
 * `undefined` — no filter — as soon as one pattern leaves the basename
 * unconstrained, since the walk keeps the union of what the patterns match.
 */
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

/**
 * Translate one glob into the regex that matches it. Separate from
 * {@link matchesGlobPattern} so a caller testing many paths against one pattern
 * compiles once rather than once per path.
 */
function compileGlobPattern(pattern: string): RegExp {
	const regexPattern = pattern
		// A walk reports `cwd`-relative paths and never prefixes them, so a
		// leading `./` is redundant and matches nothing while it stands. Raw
		// user config (`testMatch`, `exclude`) reaches here unjoined and is
		// free to carry one.
		.replace(LEADING_CURRENT_DIRECTORY, "")
		// Escape regex metacharacters (incl. `.`) so they match literally; the
		// glob wildcards `*`/`**` are translated below and are left untouched.
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		// Both doublestar forms are parked behind placeholders before the
		// single-star pass, which is what keeps that pass from reaching inside
		// their expansions. `**` expanded to `.*` in place would have its own
		// `*` rewritten to `[^/]*` a line later, leaving `.[^/]*` — a trailing
		// `**` that matches exactly one more segment. `tools/**` then matches
		// `tools/ab` but not `tools/a/b`.
		.replace(/\*\*\//g, "{{DOUBLESTAR_SLASH}}")
		.replace(/\*\*/g, "{{DOUBLESTAR}}")
		.replace(/\*/g, "[^/]*")
		.replace(/\{\{DOUBLESTAR_SLASH\}\}/g, "(.+/)?")
		.replace(/\{\{DOUBLESTAR\}\}/g, ".*");

	return new RegExp(`^${regexPattern}$`);
}

/**
 * The cache if it was declared for this pattern, otherwise `undefined` — its
 * walk was filtered for other patterns and would answer this one short.
 */
function servingCache(cache: GlobCache | undefined, pattern: string): GlobCache | undefined {
	if (cache?.leaves === undefined) {
		return cache;
	}

	// An unconstrained pattern needs files the declared walk dropped, so it
	// cannot read this cache however the declared leaves happen to look.
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

/**
 * Every file under `directoryPath`, relative to `baseDirectory`.
 *
 * `keepBasename` decides which files are worth an entry. The traversal itself
 * is irreducible — the patterns reaching here carry `**`, so no prefix or depth
 * prunes it — but what the walk *keeps* need not be every file in the tree.
 * Dropping the rest here is what keeps the returned array proportional to the
 * files a caller asked about rather than to the size of the checkout, build
 * output included.
 */
function walkDirectory(
	directoryPath: string,
	baseDirectory: string,
	keepBasename?: (basename: string) => boolean,
): Array<string> {
	const results: Array<string> = [];

	try {
		const entries = fs.readdirSync(directoryPath, { withFileTypes: true });

		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
					const fullPath = path.join(directoryPath, entry.name);
					results.push(...walkDirectory(fullPath, baseDirectory, keepBasename));
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
