import * as path from "node:path";

import type { CoverageManifest } from "../coverage-data/manifest.ts";
import type { CopyIgnoreMatcher, RootFiles } from "../instrument/discover-files.ts";
import { discoverRootFiles } from "../instrument/discover-files.ts";
import { shadowHoldsFile } from "../instrument/shadow-entry.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { hashFile } from "../utils/hash.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import { relativeToRoot } from "../utils/normalize-windows-path.ts";

interface IncrementalState {
	allCached: boolean;
	changed: boolean;
	skipFiles: Set<string>;
}

interface IncrementalStateInputs {
	fileSystem: FileSystem;
	isCopyIgnored: CopyIgnoreMatcher;
	luauRoot: PosixRoot;
	previousManifest: CoverageManifest;
}

/**
 * Checks whether every file in this root is unchanged.
 * @param options - Root, file system, copy-ignore matcher and previous manifest.
 * @param rootFiles - Files already discovered in the root; walked here when
 *   undefined and needed.
 * @returns Cache state and the files to skip.
 */
export function computeIncrementalState(
	{ fileSystem, isCopyIgnored, luauRoot, previousManifest }: IncrementalStateInputs,
	rootFiles: RootFiles | undefined,
): IncrementalState {
	const skipFiles = computeSkipFiles({ fileSystem, luauRoot, previousManifest });
	const previousCount = countPreviousFilesForRoot(luauRoot, previousManifest);
	const hasChanged = skipFiles.size !== previousCount;

	if (hasChanged) {
		return { allCached: false, changed: hasChanged, skipFiles };
	}

	const discovered = rootFiles ?? discoverRootFiles(luauRoot, { fileSystem, isCopyIgnored });
	const isFullyCached = discovered.instrumentable.size === previousCount;

	return { allCached: isFullyCached, changed: hasChanged, skipFiles };
}

function computeSkipFiles({
	fileSystem,
	luauRoot,
	previousManifest,
}: {
	fileSystem: FileSystem;
	luauRoot: PosixRoot;
	previousManifest: CoverageManifest;
}): Set<string> {
	const skipFiles = new Set<string>();

	for (const [fileKey, record] of Object.entries(previousManifest.files)) {
		const relativePath = relativeToRoot(luauRoot, fileKey);
		if (relativePath === undefined) {
			continue;
		}

		const sourcePath = path.resolve(record.originalLuauPath);

		if (!fileSystem.existsSync(sourcePath)) {
			continue;
		}

		const currentHash = hashFile(sourcePath, fileSystem);
		if (currentHash !== record.sourceHash) {
			continue;
		}

		if (
			!shadowHoldsFile(record.instrumentedLuauPath, fileSystem) ||
			!shadowHoldsFile(record.coverageMapPath, fileSystem)
		) {
			continue;
		}

		skipFiles.add(relativePath);
	}

	return skipFiles;
}

function countPreviousFilesForRoot(
	luauRoot: PosixRoot,
	previousManifest: CoverageManifest,
): number {
	let count = 0;
	for (const fileKey of Object.keys(previousManifest.files)) {
		if (relativeToRoot(luauRoot, fileKey) !== undefined) {
			count++;
		}
	}

	return count;
}
