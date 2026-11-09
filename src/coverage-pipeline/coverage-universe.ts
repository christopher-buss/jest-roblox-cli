import * as path from "node:path";
import process from "node:process";
import picomatch from "picomatch";

import { nodeFileSystem } from "../utils/file-system.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import {
	isAbsolutePath,
	normalizeWindowsPath,
	rootPrefix,
	toPosixRoot,
} from "../utils/normalize-windows-path.ts";
import type { MappedCoverageResult } from "./mapper-types.ts";

// cspell:ignore nonegate

/**
 * Include globs and ignore patterns that decide the coverage universe.
 */
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

/** Inputs of {@link narrowCoverageToFiles}. */
export interface NarrowCoverageOptions {
	/** Absolute source paths to keep. */
	files: ReadonlyArray<string>;
	/** Mapped coverage keyed by source path. */
	mapped: MappedCoverageResult;
	/**
	 * Resolves an existing path to its real spelling; throws for a missing
	 * one.
	 */
	realpath?: (file: string) => string;
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
 * @param rootDirectory - The config's `rootDir`; defaults to cwd.
 * @returns Canonical POSIX anchor directory.
 */
export function resolveUniverseAnchor(rootDirectory?: string): PosixRoot {
	const cwd = normalizeWindowsPath(process.cwd());
	return toPosixRoot(toAnchorNamespace(rootDirectory ?? cwd, cwd));
}

/**
 * The universe decision for one source path, split out so instrumentation can
 * ask the same question ahead of the run that the report asks after it — see
 * `instrument-universe.ts`. Accepts absolute or cwd-relative paths.
 * @param filter - Include globs, ignore patterns and their anchor.
 * @returns Predicate that is true for a source path in the universe.
 */
export function createCoverageUniverseMatcher(
	filter: CoverageUniverseFilter,
): (filePath: string) => boolean {
	const include = filter.include ?? [];

	const includePatterns = include.filter((pattern) => !pattern.startsWith("!"));
	const excludePatterns = include
		.filter((pattern) => pattern.startsWith("!"))
		.map((pattern) => pattern.slice(1));

	const isIncluded = includePatterns.length > 0 ? createGlobMatcher(includePatterns) : undefined;
	const isExcluded = createGlobMatcher(excludePatterns);
	// `contains: true` so a bare `index.ts` matches `src/foo/index.ts`, the same
	// way the instrument-time root matcher treats `coveragePathIgnorePatterns`.
	const isIgnored = createIgnoreMatcher(filter.ignore);

	const anchor = resolveUniverseAnchor(filter.rootDir);
	// Both sides are canonical POSIX by here, so a file under the anchor — the
	// case for every file a config means to name — is a prefix strip.
	// `path.relative` stays as the fallback for one outside it, where the answer
	// begins `..` and no glob matches anyway. Worth the split because this runs
	// once per compiled file across the whole place, and `path.relative`
	// re-resolves the anchor on every call.
	const anchorPrefix = rootPrefix(anchor);
	const cwd = normalizeWindowsPath(process.cwd());
	return (filePath) => {
		const absolute = toAnchorNamespace(filePath, cwd);
		// Stryker disable next-line MethodExpression: same path
		const relativePath = absolute.startsWith(anchorPrefix)
			? absolute.slice(anchorPrefix.length)
			: normalizeWindowsPath(path.relative(anchor, absolute));
		return (
			(isIncluded === undefined || isIncluded(relativePath)) &&
			!isExcluded(relativePath) &&
			isIgnored?.(relativePath) !== true
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
 * @param mapped - Mapped coverage keyed by source path.
 * @param filter - Include globs, ignore patterns and their anchor.
 * @returns `mapped` itself when the filter is empty, else the surviving files.
 */
export function filterCoverageUniverse(
	mapped: MappedCoverageResult,
	filter: CoverageUniverseFilter,
): MappedCoverageResult {
	// The argument itself, not an equal copy: a filter that names neither an
	// include nor an ignore has nothing to decide, and the answer is every file
	// that came in.
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
 * Narrows a mapped coverage universe to the given source files. A named file
 * outside the universe, such as a spec or a deleted module, adds nothing.
 * @param options - The universe, the files to keep and the real-path reader.
 * @returns The files of `mapped` that `files` names.
 */
export function narrowCoverageToFiles({
	files,
	mapped,
	realpath = nodeFileSystem.realpathSync.native,
}: NarrowCoverageOptions): MappedCoverageResult {
	const cwd = normalizeWindowsPath(process.cwd());
	function toRealKey(file: string): string {
		const key = toAnchorNamespace(file, cwd);
		try {
			return normalizeWindowsPath(realpath(key));
		} catch {
			return key;
		}
	}

	const kept = new Set(files.map(toRealKey));
	const narrowed = Object.fromEntries(
		Object.entries(mapped.files).filter(([filePath]) => kept.has(toRealKey(filePath))),
	);

	return { files: narrowed };
}

/**
 * A candidate path in the anchor's namespace. A relative one is still
 * cwd-relative — single mode's manifest keys its files that way — so it is
 * joined onto cwd rather than read as if it were already anchored.
 * @param filePath - Absolute or cwd-relative candidate path.
 * @param cwd - Normalized working directory.
 * @returns Normalized absolute POSIX path.
 */
function toAnchorNamespace(filePath: string, cwd: string): string {
	const normalized = normalizeWindowsPath(filePath);
	return path.posix.normalize(
		isAbsolutePath(normalized) ? normalized : path.posix.join(cwd, normalized),
	);
}

function createIgnoreMatcher(
	patterns?: Array<string>,
): ((filePath: string) => boolean) | undefined {
	return patterns === undefined
		? undefined
		: picomatch(patterns, { contains: true, nonegate: true });
}

function createGlobMatcher(patterns: Array<string>): (filePath: string) => boolean {
	const matchPath = picomatch(patterns, { nonegate: true });
	const matchBase = picomatch(patterns, { matchBase: true, nonegate: true });
	return (filePath) => matchPath(filePath) || matchBase(filePath);
}
