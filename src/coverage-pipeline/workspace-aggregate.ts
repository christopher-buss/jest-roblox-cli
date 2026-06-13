import { filterCoverageUniverse } from "./coverage-universe.ts";
import type { CoverageManifest } from "./manifest.ts";
import { mapCoverageToTypeScript, type MappedCoverageResult } from "./mapper.ts";
import type { RawCoverageData } from "./types.ts";

export interface WorkspacePackageCoverageEntry {
	coverageData: RawCoverageData | undefined;
	/**
	 * This package's effective `coveragePathIgnorePatterns`. Applied here —
	 * before the cross-package merge — so a per-package override (e.g. one
	 * package opting out of the workspace-root patterns) scopes to its own
	 * files. Matched against the mapped TS source path.
	 */
	ignorePatterns?: Array<string>;
	manifest: CoverageManifest;
	pkg: string;
}

/**
 * Map each package's raw coverage through its own manifest and merge the
 * resulting `MappedCoverageResult` records into one. Original-Luau file keys
 * may collide across packages (different sources at the same relative path);
 * mapping each pkg's data with its own manifest first avoids that ambiguity.
 *
 * Packages without coverageData (e.g. the materializer never reset `_G` for
 * them) are skipped silently. Empty input returns an empty result.
 */
export function aggregateWorkspaceCoverage(
	entries: ReadonlyArray<WorkspacePackageCoverageEntry>,
): MappedCoverageResult {
	const merged: MappedCoverageResult = { files: {} };

	for (const entry of entries) {
		if (entry.coverageData === undefined) {
			continue;
		}

		const mapped = mapCoverageToTypeScript(entry.coverageData, entry.manifest);
		const universe = filterCoverageUniverse(mapped, { ignore: entry.ignorePatterns });
		for (const [tsPath, fileCoverage] of Object.entries(universe.files)) {
			merged.files[tsPath] = fileCoverage;
		}
	}

	return merged;
}
