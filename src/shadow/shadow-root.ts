import type {
	CoverageManifest,
	InstrumentedFileRecord,
	NonInstrumentedFileRecord,
} from "../coverage-data/manifest.ts";
import type { CopyIgnoreMatcher, RootFiles } from "../instrument/discover-files.ts";
import { discoverRootFiles } from "../instrument/discover-files.ts";
import type { InstrumentUniverse } from "../instrument/instrument-universe.ts";
import type { Instrumenter } from "../instrument/instrumenter.ts";
import { nodeInstrumenter } from "../instrument/instrumenter.ts";
import { NOOP_TIMING_COLLECTOR, type TimingCollector } from "../timing/orchestration-collector.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import { underRoot } from "../utils/normalize-windows-path.ts";
import { buildInstrumentationSkipFiles } from "./instrumentation-plan.ts";
import { computeIncrementalState } from "./shadow-incremental.ts";
import type { SyncResult } from "./shadow-mirror.ts";
import { syncNonInstrumentedFiles } from "./shadow-mirror.ts";
import type { BakeOwnershipMatcher } from "./shadow-reconcile.ts";
import { reconcileShadowToSource } from "./shadow-reconcile.ts";

/** Inputs for building one root's shadow. */
export interface PrepareShadowRootOptions {
	/** Where the shadow is read and written. Defaults to the real one. */
	fileSystem: FileSystem;
	/** What writes the instrumented twins. Defaults to the real one. */
	instrumenter?: Instrumenter | undefined;
	/** Shadow entries a `beforeBuild` bake owns; the reconcile skips them. */
	isBakeOwned?: BakeOwnershipMatcher | undefined;
	/** Paths this root's shadow never carries, relative to `luauRoot`. */
	isCopyIgnored: CopyIgnoreMatcher;
	/** Source root the shadow mirrors. */
	luauRoot: PosixRoot;
	/** Manifest from the last run, whose records can be carried forward. */
	previousManifest?: CoverageManifest | undefined;
	/** Directory the shadow is written to. */
	shadowDir: string;
	/** Orchestration profiler forwarded to `instrumentRoot`. */
	timing?: TimingCollector | undefined;
	/** Narrows which prod files get probes. Absent means the whole root. */
	universe?: InstrumentUniverse | undefined;
	/** Whether to reuse `previousManifest` and reconcile against source. */
	useIncremental: boolean;
}

/** One root's shadow and the records that describe it. */
export interface ShadowRootResult {
	/** Whether the shadow differs from the previous run. */
	changed: boolean;
	/** Instrumented file records, keyed by source path. */
	files: Record<string, InstrumentedFileRecord>;
	/** Verbatim-copied file records, keyed by source path. */
	nonInstrumentedFiles: Record<string, NonInstrumentedFileRecord>;
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
	hasChanged: boolean;
	manifest: CoverageManifest;
	skipFiles: Set<string>;
}

interface InstrumentationPlan {
	incrementalFiles: IncrementalFiles | undefined;
}

type IncrementalPlan = FullCachePlan | InstrumentationPlan;

interface InstrumentedFiles {
	allFiles: Record<string, InstrumentedFileRecord>;
	changed: boolean;
}

/**
 * Instruments one root into its shadow and mirrors everything else.
 * @param options - Root, shadow directory, previous manifest and collaborators.
 * @returns The shadow's records and whether it changed.
 */
export function prepareShadowRoot(options: PrepareShadowRootOptions): ShadowRootResult {
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
		nonInstrumentedFiles: mirror.files,
	};
}

function mirrorUntouchedFiles(
	{
		fileSystem,
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

function splitRootFiles({
	fileSystem,
	isCopyIgnored,
	luauRoot,
	universe,
}: PrepareShadowRootOptions): RootFiles | undefined {
	return universe === undefined
		? undefined
		: discoverRootFiles(luauRoot, { fileSystem, isCopyIgnored, universe });
}

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
	// Outside the `||` so the cleanup always runs.
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
		nonInstrumentedFiles: syncResult.files,
	};
}

function planIncremental(
	{
		fileSystem,
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

function instrumentChangedFiles({
	excluded,
	fileSystem,
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
	const unparsed = buildInstrumentationSkipFiles({ excluded, skipFiles });
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
