import * as path from "node:path";
import process from "node:process";
import picomatch from "picomatch";

import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import type { MappedCoverageResult } from "./mapper.ts";

export interface CoverageUniverseFilter {
	/**
	 * `coveragePathIgnorePatterns` — matched against the TS source path with
	 * `contains: true`, mirroring Jest's regex-based semantics (and the
	 * instrument-time matcher in `prepare.ts`). Any match drops the file.
	 */
	ignore?: Array<string>;
	/**
	 * `collectCoverageFrom`-style globs. A leading `!` negates. When omitted or
	 * empty, every file is included (subject to `ignore`).
	 */
	include?: Array<string>;
}

/**
 * Decides which mapped source files make up the coverage report universe.
 *
 * This is the single authority for "is this source file in coverage?": every
 * mode (single, multi, workspace) routes its mapped result through here so the
 * include globs and ignore patterns cannot drift across call sites. A file
 * survives when it is included by `collectCoverageFrom` AND not matched by any
 * `coveragePathIgnorePatterns` entry.
 */
export function filterCoverageUniverse(
	mapped: MappedCoverageResult,
	filter: CoverageUniverseFilter,
): MappedCoverageResult {
	const include = filter.include ?? [];
	const ignore = filter.ignore ?? [];

	if (include.length === 0 && ignore.length === 0) {
		return mapped;
	}

	const includePatterns = include.filter((pattern) => !pattern.startsWith("!"));
	const excludePatterns = include
		.filter((pattern) => pattern.startsWith("!"))
		.map((pattern) => pattern.slice(1));

	const isIncluded = includePatterns.length > 0 ? createGlobMatcher(includePatterns) : () => true;
	const isExcluded =
		excludePatterns.length > 0 ? createGlobMatcher(excludePatterns) : () => false;
	// `contains: true` so a bare `index.ts` matches `src/foo/index.ts`, the same
	// way the instrument-time root matcher treats `coveragePathIgnorePatterns`.
	const isIgnored = ignore.length > 0 ? picomatch(ignore, { contains: true }) : () => false;

	const cwd = process.cwd();
	const filtered = Object.fromEntries(
		Object.entries(mapped.files).filter(([filePath]) => {
			const relativePath = path.isAbsolute(filePath)
				? normalizeWindowsPath(path.relative(cwd, filePath))
				: filePath;
			return (
				isIncluded(relativePath) && !isExcluded(relativePath) && !isIgnored(relativePath)
			);
		}),
	);

	return { files: filtered };
}

function createGlobMatcher(patterns: Array<string>): (filePath: string) => boolean {
	// Split by whether the pattern is path-anchored. A slash-free pattern like
	// `player.ts` must match at any depth, which needs picomatch's `matchBase`;
	// a path-containing glob like `src/**/*.ts` is matched as-is (`matchBase`
	// would be a no-op there, and applying it could mask an over-broad basename
	// match).
	const withPath = patterns.filter((pattern) => pattern.includes("/"));
	const withoutPath = patterns.filter((pattern) => !pattern.includes("/"));

	const matchers: Array<(filePath: string) => boolean> = [];
	if (withPath.length > 0) {
		matchers.push(picomatch(withPath));
	}

	if (withoutPath.length > 0) {
		matchers.push(picomatch(withoutPath, { matchBase: true }));
	}

	return (filePath) => matchers.some((matcher) => matcher(filePath));
}
