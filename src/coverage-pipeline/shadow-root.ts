import * as fs from "node:fs";
import * as path from "node:path";

import { NOOP_TIMING_COLLECTOR, type TimingCollector } from "../timing/orchestration-collector.ts";
import { hashBuffer, hashFile } from "../utils/hash.ts";
import { normalizeWindowsPath, toPosixRoot } from "../utils/normalize-windows-path.ts";
import type { CopyIgnoreMatcher, RootFiles } from "./discover-files.ts";
import {
	discoverRootFiles,
	isInstrumentableFile,
	isSkippedDirectory,
	walkLuauDirectory,
} from "./discover-files.ts";
import type { InstrumentUniverse } from "./instrument-universe.ts";
import { instrumentRoot } from "./instrumenter.ts";
import type {
	CoverageManifest,
	InstrumentedFileRecord,
	NonInstrumentedFileRecord,
} from "./manifest.ts";
import {
	clearDirectoryAtFilePath,
	createShadowDirectory,
	shadowHoldsFile,
} from "./shadow-entry.ts";

export { isNonInstrumentedFile } from "./discover-files.ts";

export interface PrepareShadowRootOptions {
	/** Paths this root's shadow never carries, relative to `luauRoot`. */
	isCopyIgnored: CopyIgnoreMatcher;
	luauRoot: string;
	previousManifest?: CoverageManifest | undefined;
	shadowDir: string;
	/** Orchestration profiler forwarded to `instrumentRoot`. */
	timing?: TimingCollector | undefined;
	/**
	 * Narrows which prod files get probes. Absent means the whole root, which
	 * is what a config without `collectCoverageFrom` asks for.
	 */
	universe?: InstrumentUniverse | undefined;
	useIncremental: boolean;
}

export interface ShadowRootResult {
	changed: boolean;
	files: Record<string, InstrumentedFileRecord>;
	luauRoot: string;
	nonInstrumentedFiles: Record<string, NonInstrumentedFileRecord>;
	shadowDir: string;
}

interface SyncResult {
	changed: boolean;
	files: Record<string, NonInstrumentedFileRecord>;
}

interface FullCacheOptions {
	excluded: Set<string>;
	isCopyIgnored: CopyIgnoreMatcher;
	luauRoot: string;
	previousManifest: CoverageManifest;
	shadowDir: string;
	skipFiles: Set<string>;
}

interface IncrementalPlan {
	/**
	 * Populated only on a full cache hit — every file in this root was
	 * unchanged, so the caller returns this verbatim without instrumenting.
	 */
	fullCacheResult?: ShadowRootResult | undefined;
	/** Previously-instrumented files were deleted or modified. */
	hasChanged: boolean;
	/** Relative paths the instrumenter can skip; undefined on a cold run. */
	skipFiles: Set<string> | undefined;
}

interface IncrementalState {
	allCached: boolean;
	changed: boolean;
	skipFiles: Set<string>;
}

/** What the incremental decision reads out of `PrepareShadowRootOptions`. */
interface IncrementalStateInputs {
	isCopyIgnored: CopyIgnoreMatcher;
	luauRoot: string;
	previousManifest: CoverageManifest;
}

/** What one root's mirror pass needs to decide and record each copy. */
interface SyncNonInstrumentedOptions {
	/** Prod files the universe denied probes, keyed relative to the root. */
	excluded: Set<string>;
	isCopyIgnored: CopyIgnoreMatcher;
	luauRoot: string;
	previousNonInstrumented: Record<string, NonInstrumentedFileRecord> | undefined;
	shadowDir: string;
}

/** One root's mirror walk: where it reads from and where it writes to. */
interface MirrorSourceTreeOptions {
	isCopyIgnored: CopyIgnoreMatcher;
	/** Source root, POSIX-normalized, with no trailing separator. */
	posixRoot: string;
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

/** What the reconcile walk holds constant across the whole tree. */
interface PruneContext {
	isCopyIgnored: CopyIgnoreMatcher;
	luauRoot: string;
	/** Shadow root every relative path is keyed from, POSIX-normalized. */
	shadowRoot: string;
}

interface InstrumentedFiles {
	allFiles: Record<string, InstrumentedFileRecord>;
	changed: boolean;
}

/**
 * Populate a shadow dir from one luauRoot: run the instrumenter to write the
 * instrumented prod twins, then sync everything it never emits (spec/test/snap
 * plus non-luau rojo files) with hash-tracked records, so the shadow is a
 * complete mirror that satisfies rojo + testMatch.
 *
 * Between them those two passes write every file the shadow carries, so no
 * pass copies the root wholesale. Directories are what neither reaches, and
 * the sync mirrors those as it walks.
 *
 * On a warm run (cache hit) only changed files are re-instrumented, and the
 * shadow is reconciled against source so files deleted upstream don't linger.
 */
export function prepareShadowRoot(options: PrepareShadowRootOptions): ShadowRootResult {
	const { luauRoot, shadowDir } = options;
	const timing = options.timing ?? NOOP_TIMING_COLLECTOR;

	const rootFiles = splitRootFiles(options);
	const plan = planIncremental(options, rootFiles);
	if (plan.fullCacheResult !== undefined) {
		return plan.fullCacheResult;
	}

	const excluded = rootFiles?.excluded ?? NO_EXCLUSIONS;
	const { allFiles, changed: hasInstrumented } = instrumentChangedFiles(
		options,
		excluded,
		plan.skipFiles,
		timing,
	);
	const mirror = mirrorUntouchedFiles(options, excluded);

	return {
		changed: plan.hasChanged || hasInstrumented || mirror.changed,
		files: allFiles,
		luauRoot,
		nonInstrumentedFiles: mirror.files,
		shadowDir,
	};
}

/**
 * Bring everything the instrumenter never emits into the shadow — spec/test/
 * snap files, non-luau rojo files, and the prod files the universe excluded —
 * then drop shadow entries whose source is gone.
 *
 * The reconcile is called outside the `||` so its cleanup side effect runs even
 * when the sync already flagged a change.
 */
function mirrorUntouchedFiles(
	{
		isCopyIgnored,
		luauRoot,
		previousManifest,
		shadowDir,
		useIncremental,
	}: PrepareShadowRootOptions,
	excluded: Set<string>,
): SyncResult {
	const synced = syncNonInstrumentedFiles({
		excluded,
		isCopyIgnored,
		luauRoot,
		previousNonInstrumented: previousManifest?.nonInstrumentedFiles,
		shadowDir,
	});
	const hasReconciled =
		useIncremental && reconcileShadowToSource(luauRoot, shadowDir, isCopyIgnored);
	return { changed: synced.changed || hasReconciled, files: synced.files };
}

/**
 * The universe split, walked only when this run has a universe at all.
 *
 * Only a run that narrows needs it up front, to know what to mirror. Without
 * one nothing is excluded, and the instrumentable set is read on a single
 * branch of the plan — so `rootFiles` stays absent and that branch walks for
 * itself, rather than every run paying a full readdir for a discarded result.
 */
function splitRootFiles({
	isCopyIgnored,
	luauRoot,
	universe,
}: PrepareShadowRootOptions): RootFiles | undefined {
	return universe === undefined
		? undefined
		: discoverRootFiles(luauRoot, { isCopyIgnored, universe });
}

/** Shared empty set for a run that narrows nothing — only ever read. */
const NO_EXCLUSIONS = new Set<string>();

const COV_MAP_SUFFIX = ".cov-map.json";

/**
 * Mirror one file into the shadow, or carry its previous record forward.
 *
 * The carry-forward wants both a matching source hash AND a file still at the
 * path the record points at: a partial cleanup or an interrupted run can leave
 * the record valid on paper while the file it names is gone — or replaced by a
 * directory, which is the same lie told the other way round.
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
 */
export function syncOneFile(
	sourcePath: string,
	shadowPath: string,
	previousRecord: NonInstrumentedFileRecord | undefined,
): NonInstrumentedFileRecord {
	const contents = fs.readFileSync(path.resolve(sourcePath));
	const currentHash = hashBuffer(contents);
	if (previousRecord?.sourceHash === currentHash && shadowHoldsFile(previousRecord.shadowPath)) {
		return previousRecord;
	}

	clearDirectoryAtFilePath(shadowPath);
	fs.writeFileSync(shadowPath, contents);

	return { shadowPath, sourceHash: currentHash, sourcePath };
}

/**
 * Best-effort deletion: something we cannot remove stays put rather than being
 * reported as gone, so the caller never rebuilds the place over a lie.
 *
 * Exported for the spine prune, which clears the same shadow under the same
 * contract.
 */
export function tryRemove(deleteEntry: () => void): boolean {
	let wasRemoved = false;
	try {
		deleteEntry();
		wasRemoved = true;
	} catch {}

	return wasRemoved;
}

/**
 * Does the source file backing a shadow entry still exist? A `.cov-map.json`
 * sidecar has no direct twin — it is keyed to its base `.luau`/`.lua`.
 */
function sourceTwinExists(luauRoot: string, relativePath: string): boolean {
	if (relativePath.endsWith(COV_MAP_SUFFIX)) {
		const base = relativePath.slice(0, -COV_MAP_SUFFIX.length);
		return (
			fs.existsSync(path.resolve(luauRoot, `${base}.luau`)) ||
			fs.existsSync(path.resolve(luauRoot, `${base}.lua`))
		);
	}

	return fs.existsSync(path.resolve(luauRoot, relativePath));
}

//
// Reconcile a warm shadow dir against its source root: drop every shadow entry
// whose source counterpart no longer exists. One rule covers files and
// directories alike, so a warm run converges on what a cold run would have
// produced.
//
// Files are the common case, across every category the pipeline manages —
// instrumented prod `.luau`, spec/test/snap, and non-luau rojo files
// (`init.meta.json`, `*.model.json`, …). Diffing against source (rather than a
// recorded file set) means a file category the sync never tracked still gets
// cleaned up, so a stale `init.meta.json` cannot survive into the rojo build
// and fail it. `.cov-map.json` sidecars are instrumenter output with no 1:1
// source twin; they map back to their base `.luau`/`.lua`.
//
// Directories matter for one shape rojo cannot tolerate: a `foo/index.ts` ->
// `foo.ts` rename leaves the shadow holding a stale `foo/` beside the fresh
// `foo.luau`, which rojo mounts as a Folder and a ModuleScript both named `foo`
// under one parent. An empty *source* directory is legitimate — a cold run
// mirrors it and rojo makes a Folder — so a directory is judged on whether its
// source counterpart exists, never on whether it still holds anything.
//
// Returns whether anything was removed, so the caller forces a place rebuild.
//
// Both callers run the mirror sync first, and that creates the shadow root
// before anything else, so the walk below always has a directory to read.
//
function reconcileShadowToSource(
	luauRoot: string,
	shadowDirectory: string,
	isCopyIgnored: CopyIgnoreMatcher,
): boolean {
	const shadowRoot = normalizeWindowsPath(shadowDirectory);
	return pruneShadowDirectory({ isCopyIgnored, luauRoot, shadowRoot }, shadowRoot);
}

function isInstrumenterOutput(relativePath: string): boolean {
	return relativePath.endsWith(COV_MAP_SUFFIX);
}

function pruneOrphanFile(
	{ isCopyIgnored, luauRoot }: PruneContext,
	relativePath: string,
	shadowPath: string,
): boolean {
	// An ignored path is judged on the pattern, not on its twin: its source is
	// still on disk, so the twin check would keep every copy a shadow seeded
	// before the pattern existed. Deciding it here is what lets a warm tree shed
	// them on the run that adds a pattern rather than on the next cold rebuild.
	//
	// A `.cov-map.json` is exempt, for the reason `shouldSyncToShadow` passes
	// over it too: the list governs what gets copied, and a sidecar was never
	// copied — the instrumenter wrote it. Judging it by the list would let a
	// pattern like `**/*.json` delete the sidecar of a module the same run just
	// probed, and the report skips a record whose map is gone, so that module
	// silently vanishes from coverage. Only the twin check applies to it, which
	// is what still clears a sidecar whose module is gone.
	if (
		(isInstrumenterOutput(relativePath) || !isCopyIgnored(relativePath)) &&
		sourceTwinExists(luauRoot, relativePath)
	) {
		return false;
	}

	return tryRemove(() => {
		fs.unlinkSync(shadowPath);
	});
}

function pruneShadowDirectory(context: PruneContext, directory: string): boolean {
	const entries = fs.readdirSync(directory, { withFileTypes: true });
	let hasDeleted = false;

	for (const entry of entries) {
		// Never descend into these — no other walk in this file does either.
		// Their fate rides on the parent directory's own source, so passing over
		// them here cannot strand an orphaned parent.
		if (entry.isDirectory() && isSkippedDirectory(entry.name)) {
			continue;
		}

		const shadowPath = normalizeWindowsPath(path.join(directory, entry.name));
		const relativePath = shadowPath.slice(context.shadowRoot.length + 1);
		const wasRemoved = entry.isDirectory()
			? pruneChildDirectory(context, relativePath, shadowPath)
			: pruneOrphanFile(context, relativePath, shadowPath);

		if (wasRemoved) {
			hasDeleted = true;
		}
	}

	return hasDeleted;
}

/**
 * A directory whose source counterpart is gone takes its whole subtree with it,
 * `node_modules`/dot-dir children included: nothing under an orphaned parent
 * can be anything but orphaned, so there is no judgement to withhold. Leaving
 * such a child behind would strand the stale `foo/` this reconcile exists to
 * clear from beside a fresh `foo.luau`.
 */
function pruneChildDirectory(
	context: PruneContext,
	relativePath: string,
	shadowPath: string,
): boolean {
	const { isCopyIgnored, luauRoot } = context;
	if (!isCopyIgnored(relativePath) && fs.existsSync(path.resolve(luauRoot, relativePath))) {
		return pruneShadowDirectory(context, shadowPath);
	}

	return tryRemove(() => {
		fs.rmSync(shadowPath, { recursive: true });
	});
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
 */
function shouldSyncToShadow(name: string): boolean {
	return !isInstrumentableFile(name) && !name.endsWith(COV_MAP_SUFFIX);
}

function carryForwardRecords(
	luauRoot: string,
	previousManifest: CoverageManifest,
	allFiles: Record<string, InstrumentedFileRecord>,
	skipFiles: Set<string>,
): void {
	const posixRoot = toPosixRoot(luauRoot);

	for (const relativePath of skipFiles) {
		const fileKey = `${posixRoot}/${relativePath}`;
		Object.assign(allFiles, { [fileKey]: previousManifest.files[fileKey] });
	}
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
 * appeared and the place has to be rebuilt around it. Returns whether any was.
 */
function mirrorSourceTree({
	isCopyIgnored,
	posixRoot,
	shadowDirectory,
}: MirrorSourceTreeOptions): MirroredTree {
	const syncPaths: Array<string> = [];
	let hasCreatedDirectory = createShadowDirectory(shadowDirectory);

	walkLuauDirectory(
		posixRoot,
		posixRoot,
		{
			accept: shouldSyncToShadow,
			onDirectory: (relativePath) => {
				if (createShadowDirectory(`${shadowDirectory}/${relativePath}`)) {
					hasCreatedDirectory = true;
				}
			},
			skip: isCopyIgnored,
		},
		syncPaths,
	);

	return { hasCreatedDirectory, syncPaths };
}

function syncNonInstrumentedFiles({
	excluded,
	isCopyIgnored,
	luauRoot,
	previousNonInstrumented,
	shadowDir,
}: SyncNonInstrumentedOptions): SyncResult {
	const posixRoot = toPosixRoot(luauRoot);
	const { hasCreatedDirectory, syncPaths } = mirrorSourceTree({
		isCopyIgnored,
		posixRoot,
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
		const sourcePath = `${posixRoot}/${relativePath}`;
		const previousRecord = previousNonInstrumented?.[sourcePath];
		const record = syncOneFile(sourcePath, `${shadowDir}/${relativePath}`, previousRecord);

		files[sourcePath] = record;
		if (record !== previousRecord) {
			hasChanged = true;
		}
	}

	return { changed: hasChanged, files };
}

function computeSkipFiles(luauRoot: string, previousManifest: CoverageManifest): Set<string> {
	const skipFiles = new Set<string>();
	const posixRoot = toPosixRoot(luauRoot);

	for (const [fileKey, record] of Object.entries(previousManifest.files)) {
		if (!fileKey.startsWith(`${posixRoot}/`)) {
			continue;
		}

		const relativePath = fileKey.slice(posixRoot.length + 1);
		const sourcePath = path.resolve(record.originalLuauPath);

		if (!fs.existsSync(sourcePath)) {
			continue;
		}

		const currentHash = hashFile(sourcePath);
		if (currentHash !== record.sourceHash) {
			continue;
		}

		// A matching source hash isn't enough: a partial cleanup or an
		// interrupted run can leave the manifest pointing at outputs that no
		// longer exist, or at a directory standing where one of them was.
		// Force re-instrumentation rather than carry either kind of lie
		// forward.
		if (
			!shadowHoldsFile(record.instrumentedLuauPath) ||
			!shadowHoldsFile(record.coverageMapPath)
		) {
			continue;
		}

		skipFiles.add(relativePath);
	}

	return skipFiles;
}

function countPreviousFilesForRoot(luauRoot: string, previousManifest: CoverageManifest): number {
	const posixRoot = toPosixRoot(luauRoot);
	let count = 0;
	for (const fileKey of Object.keys(previousManifest.files)) {
		if (fileKey.startsWith(`${posixRoot}/`)) {
			count++;
		}
	}

	return count;
}

/**
 * Check if all files in this root are unchanged (full cache hit).
 *
 * `changed` means previous files were deleted or modified — it does NOT cover
 * new files appearing on disk. When `allCached` is false but `changed` is also
 * false, new files exist and the caller detects them when `instrumentRoot`
 * returns non-empty results.
 */
function computeIncrementalState(
	{ isCopyIgnored, luauRoot, previousManifest }: IncrementalStateInputs,
	rootFiles: RootFiles | undefined,
): IncrementalState {
	const skipFiles = computeSkipFiles(luauRoot, previousManifest);
	const previousCount = countPreviousFilesForRoot(luauRoot, previousManifest);
	const hasChanged = skipFiles.size !== previousCount;

	if (hasChanged) {
		return { allCached: false, changed: hasChanged, skipFiles };
	}

	// All previous files match. Check if any new files appeared on disk. The
	// walk is deferred to here when no universe forced it earlier.
	const discovered = rootFiles ?? discoverRootFiles(luauRoot, { isCopyIgnored });
	const isFullyCached = discovered.instrumentable.size === previousCount;

	return { allCached: isFullyCached, changed: hasChanged, skipFiles };
}

function buildFullCacheResult({
	excluded,
	isCopyIgnored,
	luauRoot,
	previousManifest,
	shadowDir,
	skipFiles,
}: FullCacheOptions): ShadowRootResult {
	const allFiles: Record<string, InstrumentedFileRecord> = {};
	carryForwardRecords(luauRoot, previousManifest, allFiles, skipFiles);

	const syncResult = syncNonInstrumentedFiles({
		excluded,
		isCopyIgnored,
		luauRoot,
		previousNonInstrumented: previousManifest.nonInstrumentedFiles,
		shadowDir,
	});
	// Call reconcile unconditionally (not inside the `||`) so its cleanup side
	// effect always runs even when the sync already flagged a change.
	const hasReconciled = reconcileShadowToSource(luauRoot, shadowDir, isCopyIgnored);

	return {
		changed: syncResult.changed || hasReconciled,
		files: allFiles,
		luauRoot,
		nonInstrumentedFiles: syncResult.files,
		shadowDir,
	};
}

/**
 * Decide what the instrumenter can skip this run, and short-circuit to the
 * carried-forward result when nothing in the root changed at all.
 */
function planIncremental(
	{
		isCopyIgnored,
		luauRoot,
		previousManifest,
		shadowDir,
		useIncremental: shouldUseIncremental,
	}: PrepareShadowRootOptions,
	rootFiles: RootFiles | undefined,
): IncrementalPlan {
	if (!shouldUseIncremental || previousManifest === undefined) {
		return { hasChanged: false, skipFiles: undefined };
	}

	const {
		allCached: isFullyCached,
		changed: hasChanged,
		skipFiles,
	} = computeIncrementalState({ isCopyIgnored, luauRoot, previousManifest }, rootFiles);
	if (!isFullyCached) {
		return { hasChanged, skipFiles };
	}

	return {
		fullCacheResult: buildFullCacheResult({
			excluded: rootFiles?.excluded ?? NO_EXCLUSIONS,
			isCopyIgnored,
			luauRoot,
			previousManifest,
			shadowDir,
			skipFiles,
		}),
		hasChanged,
		skipFiles,
	};
}

/**
 * Instrument everything the plan didn't skip, then fold the skipped files'
 * previous manifest records back in so the result covers the whole root.
 */
function instrumentChangedFiles(
	{
		isCopyIgnored,
		luauRoot,
		previousManifest,
		shadowDir,
		useIncremental: shouldUseIncremental,
	}: PrepareShadowRootOptions,
	excluded: Set<string>,
	skipFiles: Set<string> | undefined,
	timing: TimingCollector,
): InstrumentedFiles {
	// One list for lute: a file it never parses is a file it never pays for.
	// The two halves stay apart up here because only `skipFiles` has a record
	// worth carrying forward — an excluded file has none and must gain none.
	const unparsed =
		skipFiles === undefined && excluded.size === 0
			? undefined
			: new Set([...(skipFiles ?? []), ...excluded]);
	const files = instrumentRoot({
		isCopyIgnored,
		luauRoot,
		shadowDir,
		skipFiles: unparsed,
		timing,
	});
	const allFiles = { ...files };

	if (shouldUseIncremental && previousManifest !== undefined && skipFiles !== undefined) {
		carryForwardRecords(luauRoot, previousManifest, allFiles, skipFiles);
	}

	return { allFiles, changed: Object.keys(files).length > 0 };
}
