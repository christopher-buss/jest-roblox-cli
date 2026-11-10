import * as path from "node:path";

import type { NonInstrumentedFileRecord } from "../coverage-data/manifest.ts";
import type { CopyIgnoreMatcher } from "../instrument/discover-files.ts";
import { isInstrumentableFile, walkLuauDirectory } from "../instrument/discover-files.ts";
import {
	clearDirectoryAtFilePath,
	createShadowDirectory,
	shadowHoldsFile,
} from "../instrument/shadow-entry.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { hashBuffer } from "../utils/hash.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import { underRoot } from "../utils/normalize-windows-path.ts";
import { COV_MAP_SUFFIX } from "./shadow-reconcile.ts";

/** Outcome of mirroring one root's verbatim files. */
export interface SyncResult {
	/** Whether any file was written or any shadow directory created. */
	changed: boolean;
	/** Records for every mirrored file, keyed by source path. */
	files: Record<string, NonInstrumentedFileRecord>;
}

interface SyncNonInstrumentedOptions {
	excluded: Set<string>;
	fileSystem: FileSystem;
	isCopyIgnored: CopyIgnoreMatcher;
	luauRoot: PosixRoot;
	previousNonInstrumented: Record<string, NonInstrumentedFileRecord> | undefined;
	shadowDir: string;
}

interface MirrorSourceTreeOptions {
	fileSystem: FileSystem;
	isCopyIgnored: CopyIgnoreMatcher;
	luauRoot: PosixRoot;
	shadowDirectory: string;
}

interface MirroredTree {
	hasCreatedDirectory: boolean;
	syncPaths: Array<string>;
}

/**
 * Mirrors one file into the shadow, or carries its previous record forward.
 * The caller creates the directory above `shadowPath`.
 * @param options - Source and shadow paths, the previous record and the file
 * system.
 * @returns The previous record when carried forward, else a new one.
 */
export function syncOneFile({
	fileSystem,
	previousRecord,
	shadowPath,
	sourcePath,
}: {
	fileSystem: FileSystem;
	previousRecord: NonInstrumentedFileRecord | undefined;
	shadowPath: string;
	sourcePath: string;
}): NonInstrumentedFileRecord {
	const contents = fileSystem.readFileSync(path.resolve(sourcePath));
	const currentHash = hashBuffer(contents);
	if (
		previousRecord?.sourceHash === currentHash &&
		previousRecord.shadowPath === shadowPath &&
		shadowHoldsFile(shadowPath, fileSystem)
	) {
		return previousRecord;
	}

	clearDirectoryAtFilePath(shadowPath, fileSystem);
	fileSystem.writeFileSync(shadowPath, contents);

	return { shadowPath, sourceHash: currentHash, sourcePath };
}

/**
 * Mirror a root's verbatim files and its universe-excluded prod files into the
 * shadow.
 * @param options - Root, shadow directory, excluded files, previous records and
 * file system.
 * @returns Whether anything changed, and the new records.
 */
export function syncNonInstrumentedFiles({
	excluded,
	fileSystem,
	isCopyIgnored,
	luauRoot,
	previousNonInstrumented,
	shadowDir,
}: SyncNonInstrumentedOptions): SyncResult {
	const { hasCreatedDirectory, syncPaths } = mirrorSourceTree({
		fileSystem,
		isCopyIgnored,
		luauRoot,
		shadowDirectory: shadowDir,
	});
	// Not spread into `push`: a whole-tree set overflows the argument limit.
	for (const relativePath of excluded) {
		syncPaths.push(relativePath);
	}

	const files: Record<string, NonInstrumentedFileRecord> = {};
	let hasChanged = hasCreatedDirectory;

	for (const relativePath of syncPaths) {
		const sourcePath = underRoot(luauRoot, relativePath);
		const previousRecord = previousNonInstrumented?.[sourcePath];
		const record = syncOneFile({
			fileSystem,
			previousRecord,
			shadowPath: `${shadowDir}/${relativePath}`,
			sourcePath,
		});

		files[sourcePath] = record;
		if (record !== previousRecord) {
			hasChanged = true;
		}
	}

	return { changed: hasChanged, files };
}

function shouldSyncToShadow(name: string): boolean {
	return !isInstrumentableFile(name) && !name.endsWith(COV_MAP_SUFFIX);
}

function mirrorSourceTree({
	fileSystem,
	isCopyIgnored,
	luauRoot,
	shadowDirectory,
}: MirrorSourceTreeOptions): MirroredTree {
	const syncPaths: Array<string> = [];
	let hasCreatedDirectory = createShadowDirectory(shadowDirectory, fileSystem);

	walkLuauDirectory({
		directory: luauRoot,
		fileSystem,
		filter: {
			accept: shouldSyncToShadow,
			onDirectory: (relativePath) => {
				if (createShadowDirectory(`${shadowDirectory}/${relativePath}`, fileSystem)) {
					hasCreatedDirectory = true;
				}
			},
			skip: isCopyIgnored,
		},
		results: syncPaths,
	});

	return { hasCreatedDirectory, syncPaths };
}
