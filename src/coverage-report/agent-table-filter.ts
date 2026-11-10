import * as path from "node:path";

import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { sourceTwinOf } from "../utils/test-file-kind.ts";
import type { MappedCoverageResult } from "./mapper-types.ts";

/** Decides whether a source file shows in the agent text table. */
export type CoverageDisplayPredicate = (normalizedAbsolutePath: string) => boolean;

/**
 * Keep files that are the source twin of one of `testFiles`.
 * @param testFiles - Test file paths, absolute or relative to `rootDirectory`.
 * @param rootDirectory - Base for resolving relative test paths.
 * @returns A predicate over normalized-absolute source paths.
 */
export function sourceTwinFilter(
	testFiles: ReadonlyArray<string>,
	rootDirectory: string,
): CoverageDisplayPredicate {
	const twins = new Set(
		testFiles.map((file) => {
			const absolute = normalizeWindowsPath(path.resolve(rootDirectory, file));
			return sourceTwinOf(absolute);
		}),
	);

	return (candidate) => twins.has(candidate);
}

/**
 * Keep files under one of `roots`.
 * @param roots - Static include roots of the selected projects.
 * @returns A predicate over normalized-absolute source paths.
 */
export function projectRootFilter(roots: ReadonlyArray<string>): CoverageDisplayPredicate {
	const normalizedRoots = roots.map((root) => normalizeWindowsPath(root));

	return (candidate) => {
		return normalizedRoots.some(
			(root) => candidate === root || candidate.startsWith(`${root}/`),
		);
	};
}

/**
 * Narrow mapped coverage to the files `predicate` keeps.
 * Path resolution must match `filterCoverageUniverse`.
 * @param mapped - Mapped coverage of the full universe.
 * @param predicate - Decides which files the table shows.
 * @returns A new result holding only the kept files.
 */
export function narrowMappedForAgentTable(
	mapped: MappedCoverageResult,
	predicate: CoverageDisplayPredicate,
): MappedCoverageResult {
	const files = Object.fromEntries(
		Object.entries(mapped.files).filter(([filePath]) => {
			return predicate(normalizeWindowsPath(path.resolve(filePath)));
		}),
	);

	return { files };
}
