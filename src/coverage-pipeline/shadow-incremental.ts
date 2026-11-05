import * as path from "node:path";

import type { FileSystem } from "../utils/file-system.ts";
import { hashFile } from "../utils/hash.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import { relativeToRoot } from "../utils/normalize-windows-path.ts";
import type { CopyIgnoreMatcher, RootFiles } from "./discover-files.ts";
import { discoverRootFiles } from "./discover-files.ts";
import type { CoverageManifest } from "./manifest.ts";
import { shadowHoldsFile } from "./shadow-entry.ts";

interface IncrementalState {
	/** No file in the root was added, deleted or modified. */
	allCached: boolean;
	/** A previous file was deleted or modified. */
	changed: boolean;
	/** Previous files whose shadow can be reused. */
	skipFiles: Set<string>;
}

/** What the incremental decision reads out of `PrepareShadowRootOptions`. */
interface IncrementalStateInputs {
	fileSystem: FileSystem;
	isCopyIgnored: CopyIgnoreMatcher;
	luauRoot: PosixRoot;
	previousManifest: CoverageManifest;
}

/**
 * Check if all files in this root are unchanged (full cache hit).
 *
 * `changed` means previous files were deleted or modified — it does NOT cover
 * new files appearing on disk. When `allCached` is false but `changed` is also
 * false, new files exist and the caller detects them when `instrumentRoot`
 * returns non-empty results.
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

	// All previous files match. Check if any new files appeared on disk. The
	// walk is deferred to here when no universe forced it earlier.
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

		// A matching source hash isn't enough: a partial cleanup or an
		// interrupted run can leave the manifest pointing at outputs that no
		// longer exist, or at a directory standing where one of them was.
		// Force re-instrumentation rather than carry either kind of lie
		// forward.
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
