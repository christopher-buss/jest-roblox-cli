import * as path from "node:path";
import process from "node:process";
import picomatch from "picomatch";

import { isAbsolutePath, normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import type { MappedCoverageResult } from "./mapper.ts";

// cspell:ignore nonegate

export interface CoverageUniverseFilter {
	/**
	 * `coveragePathIgnorePatterns` — matched against the TS source path with
	 * `contains: true`, mirroring Jest's regex-based semantics (and the
	 * instrument-time matcher in `prepare.ts`). Any match drops the file.
	 */
	ignore?: Array<string> | undefined;
	/**
	 * `collectCoverageFrom`-style globs. A leading `!` negates. When omitted
	 * or empty, every file is included (subject to `ignore`).
	 */
	include?: Array<string> | undefined;
	/**
	 * The directory `include` is written relative to — the config's own
	 * `rootDir`, which in workspace mode is the package directory. Defaults to
	 * `process.cwd()`, which is what single mode's `rootDir` already is.
	 */
	rootDir?: string | undefined;
}

/**
 * The directory a universe's globs are anchored to.
 *
 * A glob means what the config that wrote it meant: `src/**` in a package at
 * `packages/foo` names that package's sources, not the workspace root's.
 * Anchoring on the config's own `rootDir` is what makes that true — cwd is the
 * invocation directory, which in workspace mode belongs to no package. A caller
 * that states no anchor gets cwd, which is what single mode's `rootDir` is.
 *
 * Exported so the instrument-time digest hashes the same answer the matcher
 * decides by: a second copy of this default could drift, and the cache would
 * stay warm across a universe it no longer describes.
 *
 * Resolved the cross-host way rather than through `path.resolve`, which reads
 * `D:/repo/packages/foo` as a relative filename off Linux and would hang the
 * whole universe under `<cwd>/D:/...` — an anchor no candidate path starts
 * with, so nothing matches and the digest names a directory that never existed.
 */
export function resolveUniverseAnchor(rootDirectory?: string): string {
	const cwd = normalizeWindowsPath(process.cwd());
	const anchor = toAnchorNamespace(rootDirectory ?? cwd, cwd);
	// A trailing slash would double up in `anchorPrefix`; `path.resolve` used to
	// eat it. Roots keep theirs by way of the prefix the caller rebuilds.
	return anchor.endsWith("/") ? anchor.slice(0, -1) : anchor;
}

/**
 * The universe decision for one source path, split out so instrumentation can
 * ask the same question ahead of the run that the report asks after it — see
 * `instrument-universe.ts`. Accepts absolute or cwd-relative paths.
 */
export function createCoverageUniverseMatcher(
	filter: CoverageUniverseFilter,
): (filePath: string) => boolean {
	const include = filter.include ?? [];
	const ignore = filter.ignore ?? [];

	const includePatterns = include.filter((pattern) => !pattern.startsWith("!"));
	const excludePatterns = include
		.filter((pattern) => pattern.startsWith("!"))
		.map((pattern) => pattern.slice(1));

	const isIncluded = includePatterns.length > 0 ? createGlobMatcher(includePatterns) : undefined;
	const isExcluded = createGlobMatcher(excludePatterns);
	// `contains: true` so a bare `index.ts` matches `src/foo/index.ts`, the same
	// way the instrument-time root matcher treats `coveragePathIgnorePatterns`.
	const isIgnored = picomatch(ignore, { contains: true, nonegate: true });

	const anchor = resolveUniverseAnchor(filter.rootDir);
	// Both sides are canonical POSIX by here, so a file under the anchor — the
	// case for every file a config means to name — is a prefix strip.
	// `path.relative` stays as the fallback for one outside it, where the answer
	// begins `..` and no glob matches anyway. Worth the split because this runs
	// once per compiled file across the whole place, and `path.relative`
	// re-resolves the anchor on every call.
	const anchorPrefix = `${anchor}/`;
	const cwd = normalizeWindowsPath(process.cwd());
	return (filePath) => {
		const absolute = toAnchorNamespace(filePath, cwd);
		const relativePath = absolute.startsWith(anchorPrefix)
			? absolute.slice(anchorPrefix.length)
			: normalizeWindowsPath(path.relative(anchor, absolute));
		return (
			(isIncluded === undefined || isIncluded(relativePath)) &&
			!isExcluded(relativePath) &&
			!isIgnored(relativePath)
		);
	};
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
	if ((filter.include ?? []).length === 0 && (filter.ignore ?? []).length === 0) {
		return mapped;
	}

	const isInUniverse = createCoverageUniverseMatcher(filter);
	const filtered = Object.fromEntries(
		Object.entries(mapped.files).filter(([filePath]) => isInUniverse(filePath)),
	);

	return { files: filtered };
}

/**
 * A candidate path in the anchor's namespace. A relative one is still
 * cwd-relative — single mode's manifest keys its files that way — so it is
 * joined onto cwd rather than read as if it were already anchored.
 */
function toAnchorNamespace(filePath: string, cwd: string): string {
	const normalized = normalizeWindowsPath(filePath);
	return path.posix.normalize(
		isAbsolutePath(normalized) ? normalized : path.posix.join(cwd, normalized),
	);
}

function createGlobMatcher(patterns: Array<string>): (filePath: string) => boolean {
	// Split by whether the pattern is path-anchored. A slash-free pattern like
	// `player.ts` must match at any depth, which needs picomatch's `matchBase`;
	// a path-containing glob like `src/**/*.ts` is matched as-is (`matchBase`
	// would be a no-op there, and applying it could mask an over-broad basename
	// match).
	const withPath = patterns.filter((pattern) => pattern.includes("/"));
	const withoutPath = patterns.filter((pattern) => !pattern.includes("/"));

	const matchers = [picomatch(withPath), picomatch(withoutPath, { matchBase: true })];

	return (filePath) => matchers.some((matcher) => matcher(filePath));
}
