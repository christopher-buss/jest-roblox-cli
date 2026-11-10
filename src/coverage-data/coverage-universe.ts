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

// cspell:ignore nonegate

/** Include globs and ignore patterns that decide the coverage universe. */
export interface CoverageUniverseFilter {
	/** `coveragePathIgnorePatterns`; must match the matcher in `prepare.ts`. */
	ignore?: Array<string> | undefined;
	/** `collectCoverageFrom`-style globs; a leading `!` negates. */
	include?: Array<string> | undefined;
	/** The directory `include` is relative to; defaults to cwd. */
	rootDir?: string | undefined;
}

/**
 * The directory a universe's globs are anchored to. The instrument-time digest
 * must use this; do not copy it. Not `path.resolve`: off Linux it reads
 * `D:/...` as relative.
 * @param rootDirectory - The config's `rootDir`; defaults to cwd.
 * @returns Canonical POSIX anchor directory.
 */
export function resolveUniverseAnchor(rootDirectory?: string): PosixRoot {
	const cwd = normalizeWindowsPath(process.cwd());
	return toPosixRoot(toAnchorNamespace(rootDirectory ?? cwd, cwd));
}

/**
 * Creates the universe predicate for one source path.
 * @param filter - Include globs, ignore patterns and their anchor.
 * @returns Predicate that is true for a source path in the universe.
 */
export function createCoverageUniverseMatcher(
	filter: CoverageUniverseFilter,
): (filePath: string) => boolean {
	const include = filter.include ?? ["!**/*.client.*", "!**/*.server.*"];

	const includePatterns = include.filter((pattern) => !pattern.startsWith("!"));
	const excludePatterns = include
		.filter((pattern) => pattern.startsWith("!"))
		.map((pattern) => pattern.slice(1));

	const isIncluded = includePatterns.length > 0 ? createGlobMatcher(includePatterns) : undefined;
	const isExcluded = createGlobMatcher(excludePatterns);
	const isIgnored = createIgnoreMatcher(filter.ignore);

	const anchor = resolveUniverseAnchor(filter.rootDir);
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
 * Keeps the mapped source files that are in the coverage universe.
 * @template T - Per-file coverage record.
 * @param mapped - Mapped coverage keyed by source path.
 * @param filter - Include globs, ignore patterns and their anchor.
 * @returns `mapped` itself when the filter is empty, else the surviving files.
 */
export function filterCoverageUniverse<T>(
	mapped: { files: Record<string, T> },
	filter: CoverageUniverseFilter,
): { files: Record<string, T> } {
	if (filter.include?.length === 0 && (filter.ignore ?? []).length === 0) {
		return mapped;
	}

	const isInUniverse = createCoverageUniverseMatcher(filter);
	const filtered = Object.fromEntries(
		Object.entries(mapped.files).filter(([filePath]) => isInUniverse(filePath)),
	);

	return { files: filtered };
}

/**
 * Match source paths by their real location, including Windows junctions.
 * @template T - Mapped source entry.
 * @param root0 - Files, universe and real-path reader.
 * @returns Coverage entries whose real paths match the selection.
 */
export function narrowCoverageToFiles<T>({
	files,
	mapped,
	realpath = nodeFileSystem.realpathSync.native,
}: {
	/** Deleted source paths may appear and match no coverage entries. */
	files: ReadonlyArray<string>;
	/** Source paths have passed the configured coverage filters. */
	mapped: {
		/** Deleted source paths may appear and match no coverage entries. */
		files: Record<string, T>;
	};
	/** Canonicalizes case and junctions before matching changed sources. */
	realpath?: (file: string) => string;
}): {
	/** Deleted source paths may appear and match no coverage entries. */
	files: Record<string, T>;
} {
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
