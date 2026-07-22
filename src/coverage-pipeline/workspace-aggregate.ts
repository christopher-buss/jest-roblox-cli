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

export interface WorkspacePackageUniverse {
	pkg: string;
	/** This package's mapped coverage after its own ignore patterns applied. */
	universe: MappedCoverageResult;
}

export interface WorkspaceAggregatedCoverage {
	merged: MappedCoverageResult;
	/**
	 * One entry per package that produced coverage data, in input order. The
	 * per-package view the threshold gate consumes: each package is judged
	 * against its own universe, not the cross-package merge.
	 */
	perPackage: Array<WorkspacePackageUniverse>;
}

/**
 * Map each package's raw coverage through its own manifest, keep the
 * per-package filtered universes, and merge them into one result. Original-Luau
 * file keys may collide across packages (different sources at the same relative
 * path); mapping each pkg's data with its own manifest first avoids that
 * ambiguity.
 *
 * Packages without coverageData (e.g. the materializer never reset `_G` for
 * them) are skipped silently — from the merge and from `perPackage` alike.
 * Empty input returns an empty result.
 */
export function aggregateWorkspaceCoverage(
	entries: ReadonlyArray<WorkspacePackageCoverageEntry>,
): WorkspaceAggregatedCoverage {
	const merged: MappedCoverageResult = { files: {} };
	const perPackage: Array<WorkspacePackageUniverse> = [];

	for (const entry of entries) {
		if (entry.coverageData === undefined) {
			continue;
		}

		const mapped = mapCoverageToTypeScript(entry.coverageData, entry.manifest);
		const universe = filterCoverageUniverse(mapped, { ignore: entry.ignorePatterns });
		perPackage.push({ pkg: entry.pkg, universe });
		for (const [tsPath, fileCoverage] of Object.entries(universe.files)) {
			merged.files[tsPath] = fileCoverage;
		}
	}

	return { merged, perPackage };
}
