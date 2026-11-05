import * as path from "node:path";

import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { hashBuffer } from "../utils/hash.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import { underRoot } from "../utils/normalize-windows-path.ts";
import type { CopyIgnoreMatcher } from "./discover-files.ts";
import { isInstrumentableFile, walkLuauDirectory } from "./discover-files.ts";
import type { NonInstrumentedFileRecord } from "./manifest.ts";
import {
	clearDirectoryAtFilePath,
	createShadowDirectory,
	shadowHoldsFile,
} from "./shadow-entry.ts";
import { COV_MAP_SUFFIX } from "./shadow-reconcile.ts";

/**
 * Outcome of mirroring one root's verbatim files.
 */
export interface SyncResult {
	/**
	 * Whether any file was written or any shadow directory created.
	 */
	changed: boolean;
	/**
	 * Records for every mirrored file, keyed by source path.
	 */
	files: Record<string, NonInstrumentedFileRecord>;
}

/** What one root's mirror pass needs to decide and record each copy. */
interface SyncNonInstrumentedOptions {
	/** Prod files the universe denied probes, keyed relative to the root. */
	excluded: Set<string>;
	fileSystem: FileSystem;
	isCopyIgnored: CopyIgnoreMatcher;
	luauRoot: PosixRoot;
	previousNonInstrumented: Record<string, NonInstrumentedFileRecord> | undefined;
	shadowDir: string;
}

/** One root's mirror walk: where it reads from and where it writes to. */
interface MirrorSourceTreeOptions {
	fileSystem: FileSystem;
	isCopyIgnored: CopyIgnoreMatcher;
	luauRoot: PosixRoot;
	shadowDirectory: string;
}

/** What one root's mirror walk found, and what it made on the way. */
interface MirroredTree {
	/**
	 * Whether any shadow directory had to be created. A warm run reads this
	 * as "a directory appeared upstream", which the place has to be rebuilt
	 * around.
	 */
	hasCreatedDirectory: boolean;
	/** Paths, relative to the root, the shadow carries verbatim. */
	syncPaths: Array<string>;
}

/**
 * Mirror one file into the shadow, or carry its previous record forward.
 *
 * The carry-forward wants a matching source hash AND a record naming the very
 * path this call would write AND a file still there: a partial cleanup or an
 * interrupted run can leave the record valid on paper while the file it names
 * is gone — or replaced by a directory, which is the same lie told the other
 * way round — and a record from a run that mirrored this file somewhere else
 * proves nothing about the path we mirror it to now.
 *
 * One read serves both jobs. The hash decides whether the copy is needed, and
 * when it is, the bytes are already in hand — `copyFileSync` would open and
 * read the same file a second time. The directory above `shadowPath` belongs to
 * whichever pass owns the tree: the mirror walk creates every directory it
 * enters, and the spine mirror creates the level it is about to fill.
 *
 * Exported for that spine mirror, which copies the loose files of the
 * directories above a narrowed root: one owner for "a verbatim file in the
 * shadow, with the record that decides whether to copy it again".
 * @param options - Source and shadow paths, the previous record and the file
 * system.
 * @returns The previous record when carried forward, else a new one.
 */
export function syncOneFile({
	fileSystem = nodeFileSystem,
	previousRecord,
	shadowPath,
	sourcePath,
}: {
	fileSystem?: FileSystem;
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
	// Appended one at a time: spreading a set this size into `push` passes one
	// argument per element, and a whole-tree universe overflows the limit. No
	// gate needed on the way in — `discoverRootFiles` built this set from the
	// same walk, so an ignored path never reached it.
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

/**
 * Every file the shadow dir must carry verbatim because the instrumenter never
 * emits it: spec/test/snap `.luau` plus all non-luau rojo files
 * (`init.meta.json`, `*.model.json`, …). The complement of
 * `isInstrumentableFile` — prod `.luau` is excluded because `instrumentRoot`
 * writes its instrumented copy into the shadow. `.cov-map.json` sidecars are
 * instrumenter output, not source, so they are excluded too.
 *
 * Prod files the coverage universe rules out are the one case this name-only
 * test cannot see; `syncNonInstrumentedFiles` folds them in by path. So is an
 * ignored path, for the same reason — both are filtered there.
 * @param name - File name.
 * @returns Whether the file is copied verbatim.
 */
function shouldSyncToShadow(name: string): boolean {
	return !isInstrumentableFile(name) && !name.endsWith(COV_MAP_SUFFIX);
}

/**
 * Collect everything the shadow must carry verbatim, giving each source
 * directory a twin on the way past — the root included, so a root of nothing
 * still has somewhere for its `$path` to land.
 *
 * The directory pass rides the walk rather than following it because the walk
 * reaches a parent before its children, which is the order `mkdirSync` wants
 * anyway. It is also the only pass that can see a directory holding nothing:
 * writing a file makes the directories above it, so an empty one would
 * otherwise never be created, and rojo mounts one as a Folder the runtime can
 * look up.
 *
 * A twin that had to be created is what tells a warm run that a new directory
 * appeared and the place has to be rebuilt around it.
 * @param options - Root, shadow directory, copy-ignore matcher and file system.
 * @returns Root-relative verbatim paths, and whether any directory was created.
 */
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
