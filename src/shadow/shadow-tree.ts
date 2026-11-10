import * as path from "node:path";

import type { CoverageSettings } from "../config/coverage-settings.ts";
import { loadPriorManifest } from "../coverage-data/manifest-load.ts";
import type {
	CoverageManifest,
	InstrumentedFileRecord,
	NonInstrumentedFileRecord,
} from "../coverage-data/manifest.ts";
import { MANIFEST_VERSION } from "../coverage-data/manifest.ts";
import type { CopyIgnoreMatcher } from "../instrument/discover-files.ts";
import { createCopyIgnoreMatcher, hashCopyIgnorePatterns } from "../instrument/discover-files.ts";
import type { InstrumentUniverse } from "../instrument/instrument-universe.ts";
import type { Instrumenter } from "../instrument/instrumenter.ts";
import { INSTRUMENTER_VERSION } from "../instrument/instrumenter.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import { normalizeWindowsPath, toPosixRoot } from "../utils/normalize-windows-path.ts";
import type { CoverageRoot } from "./coverage-root.ts";
import type { NarrowedMount } from "./narrow-roots.ts";
import type { BakeOwnershipMatcher } from "./shadow-reconcile.ts";
import { prepareShadowRoot } from "./shadow-root.ts";
import { prepareSpine } from "./spine.ts";

/** What one shadow tree is prepared from, every setting already resolved. */
export interface ShadowTreeInputs {
	/** Where sources are read and the shadow is written. */
	fileSystem: FileSystem;
	/** Writes the instrumented twins. */
	instrumenter: Instrumenter;
	/** Shadow entries a bake owns, which the reconcile leaves alone. */
	isBakeOwned?: BakeOwnershipMatcher | undefined;
	/** Names the prior manifest in warnings. */
	manifestLabel: string;
	/** Where the prior manifest is read. */
	manifestPath: string;
	/** Discovered roots, relative to the frame `sourcePrefix` names. */
	narrowed: Array<NarrowedMount>;
	/** Cache switch and copy-ignore list, already resolved. */
	settings: Pick<CoverageSettings, "coverageCache" | "coverageCopyIgnorePatterns">;
	/** The directory the tree is written to. */
	shadowRoot: string;
	/** Prefix that turns a frame-relative path into a manifest key. */
	sourcePrefix: string;
	/** Records the per-root sub-phases. */
	timing?: TimingCollector | undefined;
	/** Files that earn probes; absent probes every file. */
	universe: InstrumentUniverse | undefined;
}

/** One instrumented shadow tree and what its manifest records. */
export interface ShadowTree {
	/** `true` when any shadow file was written or removed. */
	changed: boolean;
	/** Digest of the copy-ignore list, for the next run's gate. */
	copyIgnoreHash: string;
	/** Each frame-relative root paired with its absolute shadow copy. */
	coverageRoots: Array<CoverageRoot>;
	/** The demoted levels, paired with the shadow copy that stands in. */
	coverageSpine: Array<CoverageRoot>;
	/** Instrumented files, keyed by manifest file key. */
	files: Record<string, InstrumentedFileRecord>;
	/** `true` when the prior tree was reused. */
	isIncremental: boolean;
	/** Every narrowed root, frame-relative. */
	luauRoots: Array<PosixRoot>;
	/** Files mirrored without probes, by source path. */
	nonInstrumentedFiles: Record<string, NonInstrumentedFileRecord>;
	/** The prior manifest, when it loaded. */
	previousManifest: CoverageManifest | undefined;
	/** The directory the tree was written to. */
	shadowRoot: string;
	/** The universe the tree was instrumented against. */
	universe: InstrumentUniverse | undefined;
}

/** Fields a manifest takes from the build rather than from the shadow tree. */
export interface ManifestBuildFields {
	/** Links the manifest to its sibling Build Manifest. */
	buildId: string;
	/** The built place, when the caller built one. */
	placeFilePath?: string | undefined;
	/** Digest of the rojo inputs outside the roots. */
	rojoInputsHash?: string | undefined;
}

/**
 * Instrument the discovered roots into one shadow tree, reusing the prior
 * tree when its manifest still describes it and wiping it otherwise.
 * @param inputs - Roots, frame, shadow location and resolved settings.
 * @returns The roots and spine the place mounts, and the manifest records.
 */
export function prepareShadowTree(inputs: ShadowTreeInputs): ShadowTree {
	const { fileSystem, narrowed, settings, shadowRoot, sourcePrefix } = inputs;
	const toSourcePath = sourceResolver(sourcePrefix);
	const copyIgnoreHash = hashCopyIgnorePatterns(settings.coverageCopyIgnorePatterns);
	const isCopyIgnored = createCopyIgnoreMatcher(settings.coverageCopyIgnorePatterns);
	const luauRoots = narrowed.flatMap((entry) => entry.roots);
	const reuse = decideReuse(inputs, { copyIgnoreHash, luauRoots });

	const spine = prepareSpine({
		fileSystem,
		isBakeOwned: inputs.isBakeOwned,
		isCopyIgnored,
		narrowed,
		previousNonInstrumented: reuse.previousManifest?.nonInstrumentedFiles,
		shadowRoot,
		toSourcePath,
	});
	const tree = instrumentRoots(inputs, { ...reuse, isCopyIgnored, luauRoots, toSourcePath });

	return {
		...tree,
		...reuse,
		changed: spine.changed || tree.changed,
		copyIgnoreHash,
		coverageSpine: spine.directories,
		luauRoots,
		nonInstrumentedFiles: { ...spine.files, ...tree.nonInstrumentedFiles },
		shadowRoot,
		universe: inputs.universe,
	};
}

/**
 * The manifest that describes a shadow tree.
 * @param tree - What was instrumented and mirrored.
 * @param build - Build id, place and rojo digest the build supplies.
 * @returns The Coverage Manifest, ready to write.
 */
export function createCoverageManifest(
	tree: ShadowTree,
	{ buildId, placeFilePath, rojoInputsHash }: ManifestBuildFields,
): CoverageManifest {
	const generatedAt = new Date();
	return {
		buildId,
		copyIgnoreHash: tree.copyIgnoreHash,
		coverageUniverseHash: tree.universe?.digest,
		files: tree.files,
		generatedAt: generatedAt.toISOString(),
		instrumenterVersion: INSTRUMENTER_VERSION,
		luauRoots: tree.luauRoots,
		nonInstrumentedFiles: tree.nonInstrumentedFiles,
		...(placeFilePath === undefined ? {} : { placeFilePath }),
		rojoInputsHash,
		shadowDir: normalizeWindowsPath(tree.shadowRoot),
		version: MANIFEST_VERSION,
	};
}

function sourceResolver(sourcePrefix: string): (relativePath: string) => string {
	return (relativePath) => normalizeWindowsPath(path.join(sourcePrefix, relativePath));
}

function hasDroppedLuauRoot(previous: Array<string>, current: Array<string>): boolean {
	const currentSet = new Set(current.map(normalizeWindowsPath));
	return previous.some((root) => !currentSet.has(normalizeWindowsPath(root)));
}

function canReuseCoverageManifest(
	previousManifest: CoverageManifest | undefined,
	{
		copyIgnoreHash,
		coverageCache,
		universe,
	}: { copyIgnoreHash: string; coverageCache: boolean; universe: InstrumentUniverse | undefined },
): previousManifest is CoverageManifest {
	return (
		coverageCache &&
		previousManifest?.instrumenterVersion === INSTRUMENTER_VERSION &&
		previousManifest.copyIgnoreHash === copyIgnoreHash &&
		previousManifest.coverageUniverseHash === universe?.digest
	);
}

function decideReuse(
	{ fileSystem, manifestLabel, manifestPath, settings, shadowRoot, universe }: ShadowTreeInputs,
	{ copyIgnoreHash, luauRoots }: { copyIgnoreHash: string; luauRoots: Array<PosixRoot> },
): Pick<ShadowTree, "isIncremental" | "previousManifest"> {
	const previousManifest = loadPriorManifest({ fileSystem, label: manifestLabel, manifestPath });
	// A dropped root is invisible to the per-root reconcile, so its shadow
	// subtree would survive a reuse.
	const isIncremental =
		canReuseCoverageManifest(previousManifest, {
			copyIgnoreHash,
			coverageCache: settings.coverageCache,
			universe,
		}) && !hasDroppedLuauRoot(previousManifest.luauRoots, luauRoots);

	if (!isIncremental && fileSystem.existsSync(shadowRoot)) {
		fileSystem.rmSync(shadowRoot, { recursive: true });
	}

	return { isIncremental, previousManifest };
}

function instrumentRoots(
	{ fileSystem, instrumenter, isBakeOwned, shadowRoot, timing, universe }: ShadowTreeInputs,
	{
		isCopyIgnored,
		isIncremental,
		luauRoots,
		previousManifest,
		toSourcePath,
	}: {
		isCopyIgnored: CopyIgnoreMatcher;
		isIncremental: boolean;
		luauRoots: Array<PosixRoot>;
		previousManifest: CoverageManifest | undefined;
		toSourcePath: (relativePath: string) => string;
	},
): Pick<ShadowTree, "changed" | "coverageRoots" | "files" | "nonInstrumentedFiles"> {
	const files: Record<string, InstrumentedFileRecord> = {};
	const nonInstrumentedFiles: Record<string, NonInstrumentedFileRecord> = {};
	const coverageRoots: Array<CoverageRoot> = [];
	let hasChanges = false;

	for (const luauRoot of luauRoots) {
		const shadowDirectory = normalizeWindowsPath(path.join(shadowRoot, luauRoot));
		const result = prepareShadowRoot({
			fileSystem,
			instrumenter,
			isBakeOwned,
			isCopyIgnored,
			luauRoot: toPosixRoot(toSourcePath(luauRoot)),
			previousManifest,
			shadowDir: shadowDirectory,
			timing,
			universe,
			useIncremental: isIncremental,
		});
		hasChanges ||= result.changed;
		Object.assign(files, result.files);
		Object.assign(nonInstrumentedFiles, result.nonInstrumentedFiles);
		coverageRoots.push({
			luauRoot,
			shadowDir: normalizeWindowsPath(path.resolve(shadowDirectory)),
		});
	}

	return { changed: hasChanges, coverageRoots, files, nonInstrumentedFiles };
}
