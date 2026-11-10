import * as path from "node:path";

import type { CoverageUniverseFilter } from "../coverage-data/coverage-universe.ts";
import {
	createCoverageUniverseMatcher,
	resolveUniverseAnchor,
} from "../coverage-data/coverage-universe.ts";
import { resolveSourcePath } from "../coverage-data/source-path.ts";
import { isFileNotFound } from "../utils/file-not-found.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { hashString } from "../utils/hash.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";

/**
 * Which compiled Luau files to probe. Must agree with
 * `filterCoverageUniverse`: both ask `createCoverageUniverseMatcher` about the
 * same source path.
 */
export interface InstrumentUniverse {
	/** Stable digest of the patterns, for the incremental cache. */
	digest: string;
	/** Whether the compiled file at `luauPath` should be instrumented. */
	includes: (luauPath: string) => boolean;
}

/**
 * Build the gate for a set of coverage globs.
 * @param filter - Include globs, ignore patterns and their anchor.
 * @param fileSystem - File system that source-map sidecars are read through.
 * @returns The gate, or `undefined` when `include` is empty.
 */
export function createInstrumentUniverse(
	filter: CoverageUniverseFilter,
	fileSystem: FileSystem,
): InstrumentUniverse | undefined {
	if (filter.include?.length === 0) {
		return undefined;
	}

	const { include } = filter;
	const ignore = filter.ignore ?? [];
	const anchor = resolveUniverseAnchor(filter.rootDir);
	const isInUniverse = createCoverageUniverseMatcher(filter);
	const decided = new Map<string, boolean>();

	return {
		digest: hashString(
			JSON.stringify({ anchor, ignore: ignore.toSorted(), include: include?.toSorted() }),
		),
		includes: (luauPath) => {
			const wasDecided = decided.get(luauPath);
			if (wasDecided !== undefined) {
				return wasDecided;
			}

			const sources = readSourcePaths(fileSystem, luauPath);
			const isIncluded = sources === undefined || sources.some(isInUniverse);
			decided.set(luauPath, isIncluded);
			return isIncluded;
		},
	};
}

/**
 * No sidecar: the file is its own source, as in `mapCoverageToTypeScript`.
 *
 * @param fileSystem - File system to read the sidecar through.
 * @param luauPath - Compiled Luau file path.
 * @returns Source paths, or `undefined` when the sidecar is unusable.
 */
function readSourcePaths(fileSystem: FileSystem, luauPath: string): Array<string> | undefined {
	const sourceMapPath = `${luauPath}.map`;

	let raw: string;
	try {
		raw = fileSystem.readFileSync(sourceMapPath, "utf-8");
	} catch (err) {
		return isFileNotFound(err) ? [normalizeWindowsPath(luauPath)] : undefined;
	}

	let parsed: JSONValue;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return undefined;
	}

	const { sources } = parsed;
	if (!Array.isArray(sources)) {
		return undefined;
	}

	const sourceMapDirectory = path.posix.dirname(normalizeWindowsPath(sourceMapPath));
	const resolved = sources
		.filter((source): source is string => typeof source === "string")
		.map((source) => resolveSourcePath(source, sourceMapDirectory));

	return resolved.length > 0 ? resolved : undefined;
}
