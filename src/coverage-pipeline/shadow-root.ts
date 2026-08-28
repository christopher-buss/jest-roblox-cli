import * as fs from "node:fs";
import * as path from "node:path";

import { NOOP_TIMING_COLLECTOR, type TimingCollector } from "../timing/orchestration-collector.ts";
import { hashFile } from "../utils/hash.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
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
 * Populate a shadow dir from one luauRoot: bulk-copy every file (cold path),
 * run the instrumenter to overlay instrumented prod files, then sync the files
 * the instrumenter never emits (spec/test/snap plus non-luau rojo files) with
 * hash-tracked records so the shadow is a complete mirror that satisfies rojo
 * + testMatch.
 *
 * On a warm run (cache hit) only changed files are re-instrumented, and the
 * shadow is reconciled against source so files deleted upstream don't linger.
 */
export function prepareShadowRoot(options: PrepareShadowRootOptions): ShadowRootResult {
	const { luauRoot, shadowDir } = options;
	const timing = options.timing ?? NOOP_TIMING_COLLECTOR;

	seedColdShadow(options);

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

/**
 * Best-effort deletion: something we cannot remove stays put rather than being
 * reported as gone, so the caller never rebuilds the place over a lie.
 */
function remove(deleteEntry: () => void): boolean {
	let wasRemoved = false;
	try {
		deleteEntry();
		wasRemoved = true;
	} catch {}

	return wasRemoved;
}

//
// Reconcile a warm shadow dir against its source root: drop every shadow entry
// whose source counterpart no longer exists. One rule covers files and
// directories alike, so a warm run converges on what a cold `cpSync` would have
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
//
function reconcileShadowToSource(
	luauRoot: string,
	shadowDirectory: string,
	isCopyIgnored: CopyIgnoreMatcher,
): boolean {
	if (!fs.existsSync(shadowDirectory)) {
		return false;
	}

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

	return remove(() => {
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

	return remove(() => {
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
	const posixRoot = normalizeWindowsPath(luauRoot);

	for (const relativePath of skipFiles) {
		const fileKey = `${posixRoot}/${relativePath}`;
		Object.assign(allFiles, { [fileKey]: previousManifest.files[fileKey] });
	}
}

function discoverShadowSyncFiles(
	posixRoot: string,
	isCopyIgnored: CopyIgnoreMatcher,
	results: Array<string>,
): void {
	walkLuauDirectory(
		posixRoot,
		posixRoot,
		{ accept: shouldSyncToShadow, skip: isCopyIgnored },
		results,
	);
}

/**
 * Mirror one file into the shadow, or carry its previous record forward.
 *
 * The carry-forward wants both a matching source hash AND the shadow file the
 * record points at: a partial cleanup or an interrupted run can leave the
 * record valid on paper while the file it names is gone.
 */
function syncOneFile(
	sourcePath: string,
	shadowPath: string,
	previousRecord: NonInstrumentedFileRecord | undefined,
): NonInstrumentedFileRecord {
	const absoluteSource = path.resolve(sourcePath);
	const currentHash = hashFile(absoluteSource);
	if (previousRecord?.sourceHash === currentHash && fs.existsSync(previousRecord.shadowPath)) {
		return previousRecord;
	}

	fs.mkdirSync(path.dirname(shadowPath), { recursive: true });
	fs.copyFileSync(absoluteSource, shadowPath);

	return { shadowPath, sourceHash: currentHash, sourcePath };
}

function syncNonInstrumentedFiles({
	excluded,
	isCopyIgnored,
	luauRoot,
	previousNonInstrumented,
	shadowDir,
}: SyncNonInstrumentedOptions): SyncResult {
	const posixRoot = normalizeWindowsPath(luauRoot);
	const discovered: Array<string> = [];
	discoverShadowSyncFiles(posixRoot, isCopyIgnored, discovered);
	// Appended one at a time: spreading a set this size into `push` passes one
	// argument per element, and a whole-tree universe overflows the limit. No
	// gate needed on the way in — `discoverRootFiles` built this set from the
	// same walk, so an ignored path never reached it.
	for (const relativePath of excluded) {
		discovered.push(relativePath);
	}

	const files: Record<string, NonInstrumentedFileRecord> = {};
	let hasChanged = false;

	for (const relativePath of discovered) {
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
	const posixRoot = normalizeWindowsPath(luauRoot);

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
		// interrupted run can leave the manifest pointing at outputs that
		// no longer exist. Force re-instrumentation rather than carry a
		// record forward whose shadow files are gone.
		if (!fs.existsSync(record.instrumentedLuauPath) || !fs.existsSync(record.coverageMapPath)) {
			continue;
		}

		skipFiles.add(relativePath);
	}

	return skipFiles;
}

function countPreviousFilesForRoot(luauRoot: string, previousManifest: CoverageManifest): number {
	const posixRoot = normalizeWindowsPath(luauRoot);
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
 * Cold path only: bulk-copy the whole root so the shadow starts as a complete
 * mirror, before the instrumenter overlays its instrumented twins.
 *
 * This is the only pass that reaches every file, so the ignore gate is stated
 * here as well as in the walks — those govern what is added afterwards and
 * would leave whatever this already wrote.
 */
function seedColdShadow({
	isCopyIgnored,
	luauRoot,
	shadowDir,
	useIncremental,
}: PrepareShadowRootOptions): void {
	if (useIncremental) {
		return;
	}

	fs.mkdirSync(shadowDir, { recursive: true });
	// cpSync only ever hands the filter a path it built by joining onto
	// `luauRoot`, so the prefix is literal and a slice beats `path.relative`,
	// which would re-resolve both sides once per entry across the whole tree.
	// The root itself slices to `""`, which no pattern matches, so the copy is
	// never refused at its own top. The prefix is measured through `path.join`
	// rather than from `luauRoot.length`: join collapses a trailing separator,
	// so a root written `out/` would otherwise leave every slice one short.
	const prefixLength = path.join(luauRoot, "x").length - 1;
	fs.cpSync(luauRoot, shadowDir, {
		filter: (source) => !isCopyIgnored(normalizeWindowsPath(source.slice(prefixLength))),
		recursive: true,
	});
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
