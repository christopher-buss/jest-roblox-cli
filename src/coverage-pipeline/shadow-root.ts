import { NOOP_TIMING_COLLECTOR, type TimingCollector } from "../timing/orchestration-collector.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import { underRoot } from "../utils/normalize-windows-path.ts";
import type { CopyIgnoreMatcher, RootFiles } from "./discover-files.ts";
import { discoverRootFiles } from "./discover-files.ts";
import type { InstrumentUniverse } from "./instrument-universe.ts";
import type { Instrumenter } from "./instrumenter.ts";
import { nodeInstrumenter } from "./instrumenter.ts";
import type {
	CoverageManifest,
	InstrumentedFileRecord,
	NonInstrumentedFileRecord,
} from "./manifest.ts";
import { computeIncrementalState } from "./shadow-incremental.ts";
import type { SyncResult } from "./shadow-mirror.ts";
import { syncNonInstrumentedFiles } from "./shadow-mirror.ts";
import type { BakeOwnershipMatcher } from "./shadow-reconcile.ts";
import { reconcileShadowToSource } from "./shadow-reconcile.ts";

export { isNonInstrumentedFile } from "./discover-files.ts";

/**
 * Inputs for building one root's shadow.
 */
export interface PrepareShadowRootOptions {
	/**
	 * Where the shadow is read and written. Defaults to the real filesystem.
	 */
	fileSystem?: FileSystem;
	/**
	 * What writes the instrumented twins. Defaults to the real instrumenter.
	 */
	instrumenter?: Instrumenter | undefined;
	/**
	 * Shadow entries a `beforeBuild` bake writes and sweeps for itself, which
	 * the reconcile therefore leaves alone. Absent exempts nothing.
	 */
	isBakeOwned?: BakeOwnershipMatcher | undefined;
	/** Paths this root's shadow never carries, relative to `luauRoot`. */
	isCopyIgnored: CopyIgnoreMatcher;
	/**
	 * Source root the shadow mirrors.
	 */
	luauRoot: PosixRoot;
	/**
	 * Manifest from the last run, whose records can be carried forward.
	 */
	previousManifest?: CoverageManifest | undefined;
	/**
	 * Directory the shadow is written to.
	 */
	shadowDir: string;
	/** Orchestration profiler forwarded to `instrumentRoot`. */
	timing?: TimingCollector | undefined;
	/**
	 * Narrows which prod files get probes. Absent means the whole root, which
	 * is what a config without `collectCoverageFrom` asks for.
	 */
	universe?: InstrumentUniverse | undefined;
	/**
	 * Whether to reuse `previousManifest` and reconcile the shadow against
	 * source.
	 */
	useIncremental: boolean;
}

/**
 * One root's shadow and the records that describe it.
 */
export interface ShadowRootResult {
	/**
	 * Whether the shadow differs from the previous run.
	 */
	changed: boolean;
	/**
	 * Instrumented file records, keyed by source path.
	 */
	files: Record<string, InstrumentedFileRecord>;
	/**
	 * Source root the shadow mirrors.
	 */
	luauRoot: PosixRoot;
	/**
	 * Verbatim-copied file records, keyed by source path.
	 */
	nonInstrumentedFiles: Record<string, NonInstrumentedFileRecord>;
	/**
	 * Directory the shadow is written to.
	 */
	shadowDir: string;
}

interface FullCacheOptions {
	excluded: Set<string>;
	fileSystem: FileSystem;
	isBakeOwned: BakeOwnershipMatcher | undefined;
	isCopyIgnored: CopyIgnoreMatcher;
	luauRoot: PosixRoot;
	previousManifest: CoverageManifest;
	shadowDir: string;
	skipFiles: Set<string>;
}

interface FullCachePlan {
	fullCacheResult: ShadowRootResult;
}

interface IncrementalFiles {
	/** Previously-instrumented files were deleted or modified. */
	hasChanged: boolean;
	manifest: CoverageManifest;
	skipFiles: Set<string>;
}

interface InstrumentationPlan {
	/**
	 * Cached records the instrumenter carries forward; undefined on a cold run.
	 */
	incrementalFiles: IncrementalFiles | undefined;
}

type IncrementalPlan = FullCachePlan | InstrumentationPlan;

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
 * @param options - Root, shadow directory, previous manifest and collaborators.
 * @returns The shadow's records and whether it changed.
 */
export function prepareShadowRoot(options: PrepareShadowRootOptions): ShadowRootResult {
	const { luauRoot, shadowDir } = options;
	const timing = options.timing ?? NOOP_TIMING_COLLECTOR;

	const rootFiles = splitRootFiles(options);
	const plan = planIncremental(options, rootFiles);
	if ("fullCacheResult" in plan) {
		return plan.fullCacheResult;
	}

	const excluded = rootFiles?.excluded ?? NO_EXCLUSIONS;
	const { allFiles, changed: hasInstrumented } = instrumentChangedFiles({
		...options,
		excluded,
		incrementalFiles: plan.incrementalFiles,
		timing,
	});
	const mirror = mirrorUntouchedFiles(options, excluded);

	return {
		changed: plan.incrementalFiles?.hasChanged === true || hasInstrumented || mirror.changed,
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
 * @param options - Root, shadow directory, previous manifest and collaborators.
 * @param excluded - Root-relative prod files the universe denied probes.
 * @returns Whether anything changed, and the verbatim records.
 */
function mirrorUntouchedFiles(
	{
		fileSystem = nodeFileSystem,
		isBakeOwned,
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
		fileSystem,
		isCopyIgnored,
		luauRoot,
		previousNonInstrumented: previousManifest?.nonInstrumentedFiles,
		shadowDir,
	});
	const hasReconciled =
		useIncremental &&
		reconcileShadowToSource({ fileSystem, isBakeOwned, isCopyIgnored, luauRoot, shadowDir });
	return { changed: synced.changed || hasReconciled, files: synced.files };
}

/**
 * The universe split, walked only when this run has a universe at all.
 *
 * Only a run that narrows needs it up front, to know what to mirror. Without
 * one nothing is excluded, and the instrumentable set is read on a single
 * branch of the plan — so `rootFiles` stays absent and that branch walks for
 * itself, rather than every run paying a full readdir for a discarded result.
 * @param options - Root, universe, copy-ignore matcher and file system.
 * @returns The split, or `undefined` without a universe.
 */
function splitRootFiles({
	fileSystem = nodeFileSystem,
	isCopyIgnored,
	luauRoot,
	universe,
}: PrepareShadowRootOptions): RootFiles | undefined {
	return universe === undefined
		? undefined
		: discoverRootFiles(luauRoot, { fileSystem, isCopyIgnored, universe });
}

/** Shared empty set for a run that narrows nothing — only ever read. */
const NO_EXCLUSIONS = new Set<string>();

function carryForwardRecords({
	allFiles,
	luauRoot,
	previousManifest,
	skipFiles,
}: {
	allFiles: Record<string, InstrumentedFileRecord>;
	luauRoot: PosixRoot;
	previousManifest: CoverageManifest;
	skipFiles: Set<string>;
}): void {
	for (const relativePath of skipFiles) {
		const fileKey = underRoot(luauRoot, relativePath);
		Object.assign(allFiles, { [fileKey]: previousManifest.files[fileKey] });
	}
}

function buildFullCacheResult({
	excluded,
	fileSystem,
	isBakeOwned,
	isCopyIgnored,
	luauRoot,
	previousManifest,
	shadowDir,
	skipFiles,
}: FullCacheOptions): ShadowRootResult {
	const allFiles: Record<string, InstrumentedFileRecord> = {};
	carryForwardRecords({ allFiles, luauRoot, previousManifest, skipFiles });

	const syncResult = syncNonInstrumentedFiles({
		excluded,
		fileSystem,
		isCopyIgnored,
		luauRoot,
		previousNonInstrumented: previousManifest.nonInstrumentedFiles,
		shadowDir,
	});
	// Call reconcile unconditionally (not inside the `||`) so its cleanup side
	// effect always runs even when the sync already flagged a change.
	const hasReconciled = reconcileShadowToSource({
		fileSystem,
		isBakeOwned,
		isCopyIgnored,
		luauRoot,
		shadowDir,
	});

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
 * @param options - Root, shadow directory, previous manifest and collaborators.
 * @param rootFiles - The universe split, when the run has one.
 * @returns The full cached result, or the files the instrumenter may skip.
 */
function planIncremental(
	{
		fileSystem = nodeFileSystem,
		isBakeOwned,
		isCopyIgnored,
		luauRoot,
		previousManifest,
		shadowDir,
		useIncremental: shouldUseIncremental,
	}: PrepareShadowRootOptions,
	rootFiles: RootFiles | undefined,
): IncrementalPlan {
	if (!shouldUseIncremental || previousManifest === undefined) {
		return { incrementalFiles: undefined };
	}

	const state = computeIncrementalState(
		{ fileSystem, isCopyIgnored, luauRoot, previousManifest },
		rootFiles,
	);
	if (!state.allCached) {
		return {
			incrementalFiles: {
				hasChanged: state.changed,
				manifest: previousManifest,
				skipFiles: state.skipFiles,
			},
		};
	}

	return {
		fullCacheResult: buildFullCacheResult({
			excluded: rootFiles?.excluded ?? NO_EXCLUSIONS,
			fileSystem,
			isBakeOwned,
			isCopyIgnored,
			luauRoot,
			previousManifest,
			shadowDir,
			skipFiles: state.skipFiles,
		}),
	};
}

/**
 * Instrument everything the plan didn't skip, then fold the skipped files'
 * previous manifest records back in so the result covers the whole root.
 * @param options - Shadow inputs plus the excluded and skippable files.
 * @returns Records for the whole root, and whether any file was instrumented.
 */
function instrumentChangedFiles({
	excluded,
	fileSystem = nodeFileSystem,
	incrementalFiles,
	instrumenter = nodeInstrumenter,
	isCopyIgnored,
	luauRoot,
	shadowDir,
	timing,
}: PrepareShadowRootOptions & {
	excluded: Set<string>;
	incrementalFiles: IncrementalFiles | undefined;
	timing: TimingCollector;
}): InstrumentedFiles {
	const skipFiles = incrementalFiles?.skipFiles;
	// One list for lute: a file it never parses is a file it never pays for.
	// The two halves stay apart up here because only `skipFiles` has a record
	// worth carrying forward — an excluded file has none and must gain none.
	const unparsed =
		skipFiles === undefined && excluded.size === 0
			? undefined
			: new Set([...(skipFiles ?? []), ...excluded]);
	const files = instrumenter({
		fileSystem,
		isCopyIgnored,
		luauRoot,
		shadowDir,
		skipFiles: unparsed,
		timing,
	});
	const allFiles = { ...files };

	if (incrementalFiles !== undefined) {
		carryForwardRecords({
			allFiles,
			luauRoot,
			previousManifest: incrementalFiles.manifest,
			skipFiles: incrementalFiles.skipFiles,
		});
	}

	return { allFiles, changed: Object.keys(files).length > 0 };
}
