import * as fs from "node:fs";
import * as path from "node:path";

import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import type { CopyIgnoreMatcher } from "./discover-files.ts";
import type { NonInstrumentedFileRecord } from "./manifest.ts";
import type { NarrowedMount } from "./narrow-roots.ts";
import type { CoverageRoot } from "./redirect-path.ts";
import { isWithinRoot } from "./redirect-path.ts";
import { syncOneFile, tryRemove } from "./shadow-root.ts";

/**
 * Where a shadow tree keeps the copies it mounts for the levels it demoted.
 * Inside the shadow so the cold wipe takes them with it, and dot-prefixed
 * because every pipeline walk passes over such a directory — a spine level is
 * not a root.
 */
const SPINE_DIR = ".spine";

/**
 * The directory a spine level's own files actually sit in, one below the
 * mirror of its source path.
 *
 * Rojo mounts a directory whole, so a level's mount may not contain the level
 * below it: the demote hangs that one off an explicit child as well, and rojo
 * would build both into same-named Instances. The leaf breaks that up — two
 * levels on one chain mirror to `<a>/.self` and `<a>/<b>/.self`, siblings
 * rather than one inside the other.
 *
 * Which holds as long as `<b>` is never `.self`, and dot-prefixing is what
 * buys that: every level below the mount is a directory the coverage walk
 * descended to reach a root, and that walk passes over a dot-prefixed name.
 */
const SPINE_LEAF = ".self";

/**
 * Where the built place reads each source directory from, for a caller that
 * bakes files into the shadow before the build.
 *
 * The two differ wherever the narrowing demoted a directory: the mirror there
 * holds the roots below it, which the place reaches through explicit nodes,
 * while the directory's own contents come from the spine copy. A bake that
 * assumed the mirror would land its file somewhere nothing mounts.
 */
export interface ShadowLayout {
	/** The directory the place mounts in `sourceRelative`'s place. */
	mountedDirectory: (sourceRelative: string) => string;
	/** The shadow root, for a sweep over everything a bake has written. */
	root: string;
}

/** What the spine pass produced for one shadow tree. */
export interface PreparedSpine {
	changed: boolean;
	/** Every demoted level, paired with the copy the place mounts for it. */
	directories: Array<CoverageRoot>;
	files: Record<string, NonInstrumentedFileRecord>;
}

export interface PrepareSpineOptions {
	/** Paths the shadow never carries, relative to the level's own mount. */
	isCopyIgnored: CopyIgnoreMatcher;
	narrowed: ReadonlyArray<NarrowedMount>;
	previousNonInstrumented: Record<string, NonInstrumentedFileRecord> | undefined;
	/** The shadow tree the spine hangs off. */
	shadowRoot: string;
	/**
	 * The real directory a narrowed path names. Identity where those paths
	 * already are the source's own, as in single mode; a join onto the package
	 * directory in workspace mode, where they are package-relative.
	 */
	toSourcePath: (relativePath: string) => string;
}

/** What one spine mirror pass copied, and whether the place must rebuild. */
interface SpineMirrorResult {
	changed: boolean;
	files: Record<string, NonInstrumentedFileRecord>;
}

interface MirrorSpineOptions {
	/** Paths the shadow never carries, relative to `mount`. */
	isCopyIgnored: CopyIgnoreMatcher;
	/**
	 * The mount every spine directory sits under, and the frame it is keyed
	 * in.
	 */
	mount: string;
	previousNonInstrumented: Record<string, NonInstrumentedFileRecord> | undefined;
	/**
	 * Absolute spine directory by the absolute source directory it stands in
	 * for.
	 */
	spine: ReadonlyMap<string, string>;
}

/** One level of a spine mirror: where it reads from, and where it writes. */
interface MirrorLevelOptions extends MirrorSpineOptions {
	sourceDirectory: string;
	spineDirectory: string;
}

/**
 * The directories between each coverage root and the rojo `$path` mount above
 * it, the mount included and the root excluded — deepest last.
 *
 * A root below its mount is a root the place would never load: synthesis
 * rewrites a `$path` at or inside a coverage root, so the mount above keeps
 * pointing at the original sources. Demoting the mount is what fixes that, and
 * a demote needs somewhere to put the mount's own loose files — hence a spine
 * directory per level, mirrored into the shadow and mounted in the mount's
 * place, with the root hung underneath as an explicit child.
 *
 * A root that is itself a mount needs none of this, and neither does one no
 * mount contains: the first is redirected outright, the second is unreachable
 * whatever the tree says.
 */
export function resolveSpineDirectories(
	roots: ReadonlyArray<string>,
	mounts: ReadonlySet<string>,
): Array<string> {
	const spine = new Set<string>();
	for (const root of roots) {
		const mount = containingMount(root, mounts);
		if (mount === undefined) {
			continue;
		}

		for (const entry of chainTo(mount, root)) {
			spine.add(entry);
		}
	}

	return [...spine].toSorted();
}

/**
 * The whole spine pass for one shadow tree: mirror every demoted level's loose
 * files and name the copy the place mounts in its stead.
 *
 * Both prepare modes route through here so the shadow layout has one owner —
 * the `.spine` directory name, the source frame each level is keyed in, and
 * the record shape the manifest carries are all decided once.
 */
export function prepareSpine({
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
 * Where each source directory is read from once the place is built. A demoted
 * one answers with its spine copy; everything else with its own mirror.
 */
export function createShadowLayout(
	shadowRoot: string,
	narrowed: ReadonlyArray<NarrowedMount>,
): ShadowLayout {
	const demoted = new Set(narrowed.flatMap((entry) => entry.spine));
	return {
		mountedDirectory: (sourceRelative) => {
			const directory = normalizeWindowsPath(sourceRelative);
			return demoted.has(directory)
				? toSpineDirectory(shadowRoot, directory)
				: normalizeWindowsPath(path.join(shadowRoot, directory));
		},
		root: shadowRoot,
	};
}

/** Every directory from `mount` down to the root's parent, deepest last. */
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

/**
 * The deepest mount strictly above `root`. Deepest wins because a shallower
 * mount is not the one the place reads this root through — two mounts above
 * one root nest, so "deeper" is "inside the incumbent".
 */
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

/** The shadow copy that stands in for one demoted source directory. */
function toSpineDirectory(shadowRoot: string, relativePath: string): string {
	return normalizeWindowsPath(path.join(shadowRoot, SPINE_DIR, relativePath, SPINE_LEAF));
}

/**
 * Drop every spine entry this pass did not mirror. Nothing else reconciles
 * these — the per-root walk starts below them — so a source file deleted
 * between runs would otherwise keep loading from the place.
 *
 * Files are all there is to find: only the mirror and the stub bake write into
 * a spine leaf, and the leaf is where the layout puts a level's loose files
 * precisely so that nothing nests underneath it.
 */
function pruneSpineDirectory(spineDirectory: string, mirrored: ReadonlySet<string>): boolean {
	let hasDeleted = false;
	const entries = fs.readdirSync(spineDirectory, { withFileTypes: true });
	for (const entry of entries) {
		if (mirrored.has(entry.name)) {
			continue;
		}

		hasDeleted =
			tryRemove(() => {
				fs.rmSync(`${spineDirectory}/${entry.name}`);
			}) || hasDeleted;
	}

	return hasDeleted;
}

/**
 * One spine directory: its own files copied in, everything else cleared out.
 */
function mirrorOneLevel({
	isCopyIgnored,
	mount,
	previousNonInstrumented,
	sourceDirectory,
	spineDirectory,
}: MirrorLevelOptions): SpineMirrorResult {
	fs.mkdirSync(spineDirectory, { recursive: true });

	const files: Record<string, NonInstrumentedFileRecord> = {};
	const mirrored = new Set<string>();
	let hasChanged = false;

	const entries = fs.readdirSync(sourceDirectory, { withFileTypes: true });
	for (const entry of entries) {
		const sourcePath = `${sourceDirectory}/${entry.name}`;
		if (entry.isDirectory() || isCopyIgnored(sourcePath.slice(mount.length + 1))) {
			continue;
		}

		const previousRecord = previousNonInstrumented?.[sourcePath];
		const record = syncOneFile(sourcePath, `${spineDirectory}/${entry.name}`, previousRecord);
		files[sourcePath] = record;
		mirrored.add(entry.name);
		hasChanged ||= record !== previousRecord;
	}

	return { changed: pruneSpineDirectory(spineDirectory, mirrored) || hasChanged, files };
}

/**
 * Copy each spine directory's own loose files into the shadow, and drop the
 * copies whose source is gone.
 *
 * The demote points a mount at its spine directory, so whatever the source
 * directory held directly — an `init.luau`, a `.meta.json`, a file with an
 * extension rojo reads for itself — has to be there for rojo to find it. Its
 * subdirectories deliberately are not: those become explicit nodes, and a
 * directory present in both would build twice.
 *
 * The directory is created even when it holds nothing, because the demote
 * names it either way and rojo fails on a `$path` that is not there.
 */
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
