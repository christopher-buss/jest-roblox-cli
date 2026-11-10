import * as path from "node:path";

import type { NonInstrumentedFileRecord } from "../coverage-data/manifest.ts";
import type { CopyIgnoreMatcher } from "../instrument/discover-files.ts";
import type { StubMount } from "../staging/synthesizer-types.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import {
	isWithinRoot,
	normalizeWindowsPath,
	toPosixRoot,
} from "../utils/normalize-windows-path.ts";
import type { CoverageRoot } from "./coverage-root.ts";
import type { NarrowedMount } from "./narrow-roots.ts";
import { syncOneFile } from "./shadow-mirror.ts";
import type { BakeOwnershipMatcher } from "./shadow-reconcile.ts";
import { tryRemove } from "./shadow-reconcile.ts";

// Dot-prefixed so every pipeline walk skips it.
const SPINE_DIR = ".spine";

// Dot-prefixed so no spine level can be named `.self`: the coverage walk
// skips dot-prefixed directories.
const SPINE_LEAF = ".self";

/** Where the built place reads each source directory from. */
export interface ShadowLayout {
	/** True when the place reads `sourceRelative` from the shadow. */
	isShadowed: (sourceRelative: string) => boolean;
	/** The directory the place mounts in `sourceRelative`'s place. */
	mountedDirectory: (sourceRelative: string) => string;
	/** The shadow root, for a sweep over everything a bake has written. */
	root: string;
}

/** A bake and the shadow entries it owns. */
export interface ShadowBake {
	/** @see BakeOwnershipMatcher */
	isBakeOwned: BakeOwnershipMatcher;
	/** Runs before the build; true when it wrote anything. */
	run: (layout: ShadowLayout) => boolean;
	/** The stubs the place mounts for the directories it reads from source. */
	stubMounts: (layout: ShadowLayout) => Array<StubMount>;
}

/** What the spine pass produced for one shadow tree. */
export interface PreparedSpine {
	/** A spine file was copied or removed. */
	changed: boolean;
	/** Every demoted level, paired with the copy the place mounts for it. */
	directories: Array<CoverageRoot>;
	/** Records for the mirrored files, by source path. */
	files: Record<string, NonInstrumentedFileRecord>;
}

/** Inputs of {@link prepareSpine}. */
export interface PrepareSpineOptions {
	/** Where the mirror reads and writes. Defaults to the real filesystem. */
	fileSystem: FileSystem;
	/** Shadow entries a `beforeBuild` bake writes and sweeps for itself. */
	isBakeOwned?: BakeOwnershipMatcher | undefined;
	/** Paths the shadow never carries, relative to the level's own mount. */
	isCopyIgnored: CopyIgnoreMatcher;
	/** Narrowed mounts whose spine levels to mirror. */
	narrowed: ReadonlyArray<NarrowedMount>;
	/** Records from the previous run, for unchanged-file reuse. */
	previousNonInstrumented: Record<string, NonInstrumentedFileRecord> | undefined;
	/** The shadow tree the spine hangs off. */
	shadowRoot: string;
	/** The real directory a narrowed path names. */
	toSourcePath: (relativePath: string) => string;
}

interface SpineMirrorResult {
	changed: boolean;
	files: Record<string, NonInstrumentedFileRecord>;
}

interface MirrorSpineOptions {
	fileSystem: FileSystem;
	isBakeOwned: BakeOwnershipMatcher | undefined;
	isCopyIgnored: CopyIgnoreMatcher;
	mount: string;
	previousNonInstrumented: Record<string, NonInstrumentedFileRecord> | undefined;
	spine: ReadonlyMap<string, string>;
}

interface PruneSpineOptions {
	fileSystem: FileSystem;
	isBakeOwned: BakeOwnershipMatcher | undefined;
	mirrored: ReadonlySet<string>;
	spineDirectory: string;
}

interface MirrorLevelOptions extends MirrorSpineOptions {
	sourceDirectory: string;
	spineDirectory: string;
}

/**
 * The directories between each coverage root and the rojo `$path` mount above
 * it, the mount included and the root excluded.
 * @param roots - Canonical coverage roots.
 * @param mounts - Rojo `$path` mounts.
 * @returns Sorted spine levels.
 */
export function resolveSpineDirectories(
	roots: ReadonlyArray<PosixRoot>,
	mounts: ReadonlySet<string>,
): Array<PosixRoot> {
	const spine = new Set<PosixRoot>();
	for (const root of roots) {
		const mount = containingMount(root, mounts);
		if (mount === undefined) {
			continue;
		}

		for (const entry of chainTo(mount, root)) {
			spine.add(toPosixRoot(entry));
		}
	}

	return [...spine].toSorted();
}

/**
 * Mirrors every demoted level's loose files into one shadow tree.
 * @param options - Narrowed mounts, shadow root, source frame and prior records.
 * @returns Change flag, mounted spine directories and file records.
 */
export function prepareSpine({
	fileSystem,
	isBakeOwned,
	isCopyIgnored,
	narrowed,
	previousNonInstrumented,
	shadowRoot,
	toSourcePath,
}: PrepareSpineOptions): PreparedSpine {
	const files: Record<string, NonInstrumentedFileRecord> = {};
	const directories: Array<CoverageRoot> = [];
	let hasChanged = false;

	for (const entry of narrowed) {
		const spine = new Map(
			entry.spine.map((level) => {
				return [toSourcePath(level), toSpineDirectory(shadowRoot, level)];
			}),
		);
		const mirror = mirrorSpineFiles({
			fileSystem,
			isBakeOwned,
			isCopyIgnored,
			mount: toSourcePath(entry.luauRoot),
			previousNonInstrumented,
			spine,
		});
		Object.assign(files, mirror.files);
		hasChanged ||= mirror.changed;

		for (const level of entry.spine) {
			directories.push({
				luauRoot: level,
				shadowDir: normalizeWindowsPath(path.resolve(toSpineDirectory(shadowRoot, level))),
			});
		}
	}

	return { changed: hasChanged, directories, files };
}

/**
 * Where each source directory is read from once the place is built.
 * @param shadowRoot - The shadow tree.
 * @param narrowed - Narrowed mounts and their spine levels.
 * @returns Layout over the shadow tree.
 */
export function createShadowLayout(
	shadowRoot: string,
	narrowed: ReadonlyArray<NarrowedMount>,
): ShadowLayout {
	const demoted = new Set(narrowed.flatMap((entry) => entry.spine));
	const roots = narrowed.flatMap((entry) => entry.roots);
	return {
		isShadowed: (sourceRelative) => {
			const directory = toPosixRoot(sourceRelative);
			return demoted.has(directory) || roots.some((root) => isWithinRoot(directory, root));
		},
		mountedDirectory: (sourceRelative) => {
			const directory = toPosixRoot(sourceRelative);
			return demoted.has(directory)
				? toSpineDirectory(shadowRoot, directory)
				: normalizeWindowsPath(path.join(shadowRoot, directory));
		},
		root: shadowRoot,
	};
}

function chainTo(mount: string, root: string): Array<string> {
	const chain: Array<string> = [];
	let cursor = normalizeWindowsPath(path.posix.dirname(root));
	while (cursor !== mount) {
		chain.unshift(cursor);
		cursor = path.posix.dirname(cursor);
	}

	chain.unshift(mount);
	return chain;
}

function containingMount(root: string, mounts: ReadonlySet<string>): string | undefined {
	let containing: string | undefined;
	for (const mount of mounts) {
		if (mount === root || !isWithinRoot(root, mount)) {
			continue;
		}

		if (containing === undefined || isWithinRoot(mount, containing)) {
			containing = mount;
		}
	}

	return containing;
}

function toSpineDirectory(shadowRoot: string, relativePath: string): string {
	return normalizeWindowsPath(path.join(shadowRoot, SPINE_DIR, relativePath, SPINE_LEAF));
}

function pruneSpineDirectory({
	fileSystem,
	isBakeOwned,
	mirrored,
	spineDirectory,
}: PruneSpineOptions): boolean {
	let hasDeleted = false;
	const entries = fileSystem.readdirSync(spineDirectory, { withFileTypes: true });
	for (const entry of entries) {
		if (mirrored.has(entry.name)) {
			continue;
		}

		if (isBakeOwned?.(`${spineDirectory}/${entry.name}`) === true) {
			continue;
		}

		hasDeleted =
			tryRemove(() => {
				fileSystem.rmSync(`${spineDirectory}/${entry.name}`);
			}) || hasDeleted;
	}

	return hasDeleted;
}

function mirrorOneLevel({
	fileSystem,
	isBakeOwned,
	isCopyIgnored,
	mount,
	previousNonInstrumented,
	sourceDirectory,
	spineDirectory,
}: MirrorLevelOptions): SpineMirrorResult {
	fileSystem.mkdirSync(spineDirectory, { recursive: true });

	const files: Record<string, NonInstrumentedFileRecord> = {};
	const mirrored = new Set<string>();
	let hasChanged = false;

	const entries = fileSystem.readdirSync(sourceDirectory, { withFileTypes: true });
	for (const entry of entries) {
		const sourcePath = `${sourceDirectory}/${entry.name}`;
		if (entry.isDirectory() || isCopyIgnored(sourcePath.slice(mount.length + 1))) {
			continue;
		}

		const previousRecord = previousNonInstrumented?.[sourcePath];
		const record = syncOneFile({
			fileSystem,
			previousRecord,
			shadowPath: `${spineDirectory}/${entry.name}`,
			sourcePath,
		});
		files[sourcePath] = record;
		mirrored.add(entry.name);
		hasChanged ||= record !== previousRecord;
	}

	return {
		changed:
			pruneSpineDirectory({ fileSystem, isBakeOwned, mirrored, spineDirectory }) ||
			hasChanged,
		files,
	};
}

function mirrorSpineFiles(options: MirrorSpineOptions): SpineMirrorResult {
	const files: Record<string, NonInstrumentedFileRecord> = {};
	let hasChanged = false;

	for (const [sourceDirectory, spineDirectory] of options.spine) {
		const level = mirrorOneLevel({ ...options, sourceDirectory, spineDirectory });
		Object.assign(files, level.files);
		hasChanged ||= level.changed;
	}

	return { changed: hasChanged, files };
}
