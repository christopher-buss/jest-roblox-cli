import { mapCoverageToTypeScript, type MappedCoverageResult } from "./mapper.ts";
import type { CoverageManifest, RawCoverageData } from "./types.ts";

export interface WorkspacePackageCoverageEntry {
	coverageData: RawCoverageData | undefined;
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
		for (const [tsPath, fileCoverage] of Object.entries(mapped.files)) {
			merged.files[tsPath] = fileCoverage;
		}
	}

	return merged;
}
