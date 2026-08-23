import * as fs from "node:fs";
import * as path from "node:path";

import { NOOP_TIMING_COLLECTOR, type TimingCollector } from "../timing/orchestration-collector.ts";
import { hashBuffer } from "../utils/hash.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import type { InstrumentUniverse } from "./instrument-universe.ts";
import { instrumentRoot } from "./instrumenter.ts";
import type {
	CoverageManifest,
	InstrumentedFileRecord,
	NonInstrumentedFileRecord,
} from "./manifest.ts";

/**
 * Suffixes for files that are not instrumented for coverage but still need
 * syncing to the shadow directory. Matches parse-ast.luau:131-139.
 */
const NON_INSTRUMENTED_SUFFIXES = [
	".spec.luau",
	".test.luau",
	".spec.lua",
	".test.lua",
	".snap.luau",
	".snap.lua",
] as const;

export interface PrepareShadowRootOptions {
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

/** One root's prod `.luau`/`.lua`, split by whether it earns probes. */
export interface RootFiles {
	/**
	 * Prod files outside the coverage universe. They are mirrored into the
	 * shadow verbatim rather than probed, so the place still loads them and
	 * the report never sees hit counts it would only discard.
	 */
	excluded: Set<string>;
	/** Prod files the instrumenter will probe. */
	instrumentable: Set<string>;
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
	luauRoot: string;
	previousManifest: CoverageManifest;
	shadowDirectory: string;
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

/** A directory the reconcile walks. */
interface PruneDirectoryOptions {
	/** Shadow directory being visited, POSIX-normalized. */
	directory: string;
	luauRoot: string;
	/** Shadow root every relative path is keyed from. */
	shadowRoot: string;
}

/** One entry inside a walked directory. */
interface PruneEntryOptions {
	luauRoot: string;
	/** Path under the shadow root, which is also the source-relative path. */
	relativePath: string;
	/** The entry’s own shadow path, POSIX-normalized. */
	shadowPath: string;
	shadowRoot: string;
}

interface InstrumentedFiles {
	allFiles: Record<string, InstrumentedFileRecord>;
	changed: boolean;
}

export function isNonInstrumentedFile(filename: string): boolean {
	return NON_INSTRUMENTED_SUFFIXES.some((suffix) => filename.endsWith(suffix));
}

/**
 * Fast directory walk over one root's prod .luau/.lua files, split by the
 * coverage universe. Discovery must match parse-ast.luau's discoverFiles logic
 * (same skip rules); the split on top of it is this pipeline's own.
 */
export function discoverRootFiles(luauRoot: string, universe?: InstrumentUniverse): RootFiles {
	const posixRoot = normalizeWindowsPath(luauRoot);
	const discovered: Array<string> = [];
	walkLuauDirectory(posixRoot, posixRoot, isInstrumentableFile, discovered);

	if (universe === undefined) {
		return { excluded: new Set(), instrumentable: new Set(discovered) };
	}

	const excluded = new Set<string>();
	const instrumentable = new Set<string>();
	for (const relativePath of discovered) {
		const isInUniverse = universe.includes(`${posixRoot}/${relativePath}`);
		(isInUniverse ? instrumentable : excluded).add(relativePath);
	}

	return { excluded, instrumentable };
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
	const { luauRoot, shadowDir, useIncremental: shouldUseIncremental } = options;
	const timing = options.timing ?? NOOP_TIMING_COLLECTOR;

	seedColdShadow(luauRoot, shadowDir, shouldUseIncremental);

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
	{ luauRoot, previousManifest, shadowDir, useIncremental }: PrepareShadowRootOptions,
	excluded: Set<string>,
): SyncResult {
	const synced = syncNonInstrumentedFiles(
		luauRoot,
		shadowDir,
		excluded,
		previousManifest?.nonInstrumentedFiles,
	);
	const hasReconciled = useIncremental && reconcileShadowToSource(luauRoot, shadowDir);
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
function splitRootFiles({ luauRoot, universe }: PrepareShadowRootOptions): RootFiles | undefined {
	return universe === undefined ? undefined : discoverRootFiles(luauRoot, universe);
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
 * Directories no walk in this file descends into — matching
 * parse-ast.luau:113-147.
 */
function isSkippedDirectory(name: string): boolean {
	return name === "node_modules" || name.startsWith(".");
}

/**
 * Shared directory walker. `predicate` receives the entry name and returns true
 * to collect the file.
 */
function walkLuauDirectory(
	directory: string,
	relativeTo: string,
	predicate: (name: string) => boolean,
	results: Array<string>,
): void {
	const entries = fs.readdirSync(directory, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = normalizeWindowsPath(path.join(directory, entry.name));
		if (entry.isDirectory()) {
			if (isSkippedDirectory(entry.name)) {
				continue;
			}

			walkLuauDirectory(fullPath, relativeTo, predicate, results);
		} else if (predicate(entry.name)) {
			const relative = fullPath.slice(relativeTo.length + 1);
			results.push(relative);
		}
	}
}

/**
 * Reconcile a warm shadow dir against its source root: drop every shadow entry
 * whose source counterpart no longer exists. One rule covers files and
 * directories alike, so a warm run converges on what a cold `cpSync` would have
 * produced.
 *
 * Files are the common case, across every category the pipeline manages —
 * instrumented prod `.luau`, spec/test/snap, and non-luau rojo files
 * (`init.meta.json`, `*.model.json`, …). Diffing against source (rather than a
 * recorded file set) means a file category the sync never tracked still gets
 * cleaned up, so a stale `init.meta.json` cannot survive into the rojo build
 * and fail it. `.cov-map.json` sidecars are instrumenter output with no 1:1
 * source twin; they map back to their base `.luau`/`.lua`.
 *
 * Directories matter for one shape rojo cannot tolerate: a `foo/index.ts` ->
 * `foo.ts` rename leaves the shadow holding a stale `foo/` beside the fresh
 * `foo.luau`, which rojo mounts as a Folder and a ModuleScript both named `foo`
 * under one parent. An empty *source* directory is legitimate — a cold run
 * mirrors it and rojo makes a Folder — so a directory is judged on whether its
 * source counterpart exists, never on whether it still holds anything.
 *
 * Returns whether anything was removed, so the caller forces a place rebuild.
 */
function reconcileShadowToSource(luauRoot: string, shadowDirectory: string): boolean {
	if (!fs.existsSync(shadowDirectory)) {
		return false;
	}

	const posixShadow = normalizeWindowsPath(shadowDirectory);
	return pruneShadowDirectory({
		directory: posixShadow,
		luauRoot,
		shadowRoot: posixShadow,
	});
}

function pruneOrphanFile({ luauRoot, relativePath, shadowPath }: PruneEntryOptions): boolean {
	if (sourceTwinExists(luauRoot, relativePath)) {
		return false;
	}

	// Best-effort: a file we cannot remove stays put rather than being
	// reported as gone.
	let wasRemoved = false;
	try {
		fs.unlinkSync(shadowPath);
		wasRemoved = true;
	} catch {}

	return wasRemoved;
}

function pruneShadowDirectory({ directory, luauRoot, shadowRoot }: PruneDirectoryOptions): boolean {
	const entries = fs.readdirSync(directory, { withFileTypes: true });
	let hasDeleted = false;

	for (const entry of entries) {
		// Never descend into these — no other walk in this file does either.
		// Their fate rides on the parent directory’s own source, so passing over
		// them here cannot strand an orphaned parent.
		if (entry.isDirectory() && isSkippedDirectory(entry.name)) {
			continue;
		}

		const shadowPath = normalizeWindowsPath(path.join(directory, entry.name));
		const options: PruneEntryOptions = {
			luauRoot,
			relativePath: shadowPath.slice(shadowRoot.length + 1),
			shadowPath,
			shadowRoot,
		};
		const wasRemoved = entry.isDirectory()
			? pruneChildDirectory(options)
			: pruneOrphanFile(options);

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
function pruneChildDirectory({
	luauRoot,
	relativePath,
	shadowPath,
	shadowRoot,
}: PruneEntryOptions): boolean {
	if (fs.existsSync(path.resolve(luauRoot, relativePath))) {
		return pruneShadowDirectory({ directory: shadowPath, luauRoot, shadowRoot });
	}

	// Best-effort: a subtree we cannot remove stays put rather than being
	// reported as gone.
	let wasRemoved = false;
	try {
		fs.rmSync(shadowPath, { recursive: true });
		wasRemoved = true;
	} catch {}

	return wasRemoved;
}

function isInstrumentableFile(name: string): boolean {
	return (name.endsWith(".luau") || name.endsWith(".lua")) && !isNonInstrumentedFile(name);
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
 * test cannot see; `syncNonInstrumentedFiles` folds them in by path.
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
	directory: string,
	relativeTo: string,
	results: Array<string>,
): void {
	walkLuauDirectory(directory, relativeTo, shouldSyncToShadow, results);
}

function syncNonInstrumentedFiles(
	luauRoot: string,
	shadowDirectory: string,
	excludedFiles: Set<string>,
	previousNonInstrumented: Record<string, NonInstrumentedFileRecord> | undefined,
): SyncResult {
	const posixRoot = normalizeWindowsPath(luauRoot);
	const discovered: Array<string> = [];
	discoverShadowSyncFiles(posixRoot, posixRoot, discovered);
	// Appended one at a time: spreading a set this size into `push` passes one
	// argument per element, and a whole-tree universe overflows the limit.
	for (const relativePath of excludedFiles) {
		discovered.push(relativePath);
	}

	const files: Record<string, NonInstrumentedFileRecord> = {};
	let hasChanged = false;

	for (const relativePath of discovered) {
		const sourcePath = `${posixRoot}/${relativePath}`;
		const shadowPath = `${shadowDirectory}/${relativePath}`;

		const sourceBuffer = fs.readFileSync(path.resolve(sourcePath));
		const currentHash = hashBuffer(sourceBuffer);

		const previousRecord = previousNonInstrumented?.[sourcePath];
		// Reuse the previous record only if both the source hash matches
		// AND the shadow file it points at still exists. A partial cleanup
		// could leave the record valid on paper while the file is gone.
		if (
			previousRecord?.sourceHash === currentHash &&
			fs.existsSync(previousRecord.shadowPath)
		) {
			files[sourcePath] = previousRecord;
			continue;
		}

		const outputDirectory = path.dirname(shadowPath);
		fs.mkdirSync(outputDirectory, { recursive: true });
		fs.copyFileSync(path.resolve(sourcePath), shadowPath);

		files[sourcePath] = { shadowPath, sourceHash: currentHash, sourcePath };
		hasChanged = true;
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

		const currentHash = hashBuffer(fs.readFileSync(sourcePath));
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
	luauRoot: string,
	previousManifest: CoverageManifest,
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
	const discovered = rootFiles ?? discoverRootFiles(luauRoot);
	const isFullyCached = discovered.instrumentable.size === previousCount;

	return { allCached: isFullyCached, changed: hasChanged, skipFiles };
}

function buildFullCacheResult({
	excluded,
	luauRoot,
	previousManifest,
	shadowDirectory,
	skipFiles,
}: FullCacheOptions): ShadowRootResult {
	const allFiles: Record<string, InstrumentedFileRecord> = {};
	carryForwardRecords(luauRoot, previousManifest, allFiles, skipFiles);

	const syncResult = syncNonInstrumentedFiles(
		luauRoot,
		shadowDirectory,
		excluded,
		previousManifest.nonInstrumentedFiles,
	);
	// Call reconcile unconditionally (not inside the `||`) so its cleanup side
	// effect always runs even when the sync already flagged a change.
	const hasReconciled = reconcileShadowToSource(luauRoot, shadowDirectory);

	return {
		changed: syncResult.changed || hasReconciled,
		files: allFiles,
		luauRoot,
		nonInstrumentedFiles: syncResult.files,
		shadowDir: shadowDirectory,
	};
}

/**
 * Cold path only: bulk-copy the whole root so the shadow starts as a complete
 * mirror, before the instrumenter overlays its instrumented twins.
 */
function seedColdShadow(
	luauRoot: string,
	shadowDirectory: string,
	shouldUseIncremental: boolean,
): void {
	if (shouldUseIncremental) {
		return;
	}

	fs.mkdirSync(shadowDirectory, { recursive: true });
	fs.cpSync(luauRoot, shadowDirectory, { recursive: true });
}

/**
 * Decide what the instrumenter can skip this run, and short-circuit to the
 * carried-forward result when nothing in the root changed at all.
 */
function planIncremental(
	{
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
	} = computeIncrementalState(luauRoot, previousManifest, rootFiles);
	if (!isFullyCached) {
		return { hasChanged, skipFiles };
	}

	return {
		fullCacheResult: buildFullCacheResult({
			excluded: rootFiles?.excluded ?? NO_EXCLUSIONS,
			luauRoot,
			previousManifest,
			shadowDirectory: shadowDir,
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
	const files = instrumentRoot({ luauRoot, shadowDir, skipFiles: unparsed, timing });
	const allFiles = { ...files };

	if (shouldUseIncremental && previousManifest !== undefined && skipFiles !== undefined) {
		carryForwardRecords(luauRoot, previousManifest, allFiles, skipFiles);
	}

	return { allFiles, changed: Object.keys(files).length > 0 };
}
