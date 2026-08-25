import { filterCoverageUniverse } from "./coverage-universe.ts";
import type { CoverageManifest } from "./manifest.ts";
import { mapCoverageToTypeScript, type MappedCoverageResult } from "./mapper.ts";
import type { RawCoverageData } from "./types.ts";

export interface WorkspacePackageCoverageEntry {
	coverageData: RawCoverageData | undefined;
	/**
	 * This package's effective `coveragePathIgnorePatterns`. Matched against
	 * the mapped TS source path.
	 */
	ignorePatterns?: Array<string> | undefined;
	/**
	 * This package's `collectCoverageFrom` globs. Applied here rather than at
	 * report time so a package's report and its threshold gate judge the same
	 * universe.
	 */
	includePatterns?: Array<string> | undefined;
	manifest: CoverageManifest;
	pkg: string;
	/**
	 * The package's own `rootDir` — what `includePatterns` is written relative
	 * to, and the same anchor instrumentation resolved. Required rather than
	 * defaulted: an entry that omits it would fall back to the invocation
	 * directory, which is the exact misconfiguration this anchor exists to
	 * prevent, and it would do so silently.
	 */
	rootDir: string;
}

export interface WorkspacePackageUniverse {
	pkg: string;
	/** This package's mapped coverage after its own filters applied. */
	universe: MappedCoverageResult;
}

/**
 * Map each package's raw coverage through its own manifest and narrow it to
 * that package's own universe. Original-Luau file keys may collide across
 * packages (different sources at the same relative path); mapping each pkg's
 * data with its own manifest first avoids that ambiguity. Nothing is merged
 * across packages: every consumer downstream — the report, the threshold gate —
 * works per package, and a cross-package pool would let one package's coverage
 * mask another's.
 *
 * Packages without coverageData (e.g. the materializer never reset `_G` for
 * them) are skipped silently. Empty input returns an empty list.
 */
export function aggregateWorkspaceCoverage(
	entries: ReadonlyArray<WorkspacePackageCoverageEntry>,
): Array<WorkspacePackageUniverse> {
	const perPackage: Array<WorkspacePackageUniverse> = [];

	for (const entry of entries) {
		if (entry.coverageData === undefined) {
			continue;
		}

		const mapped = mapCoverageToTypeScript(entry.coverageData, entry.manifest);
		perPackage.push({
			pkg: entry.pkg,
			universe: filterCoverageUniverse(mapped, {
				ignore: entry.ignorePatterns,
				include: entry.includePatterns,
				rootDir: entry.rootDir,
			}),
		});
	}

	return perPackage;
}
