import * as path from "node:path";
import type { Except } from "type-fest";

import type { CopyIgnoreMatcher } from "../instrument/discover-files.ts";
import { isInstrumentableFile, walkLuauDirectory } from "../instrument/discover-files.ts";
import type { InstrumentUniverse } from "../instrument/instrument-universe.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import { isWithinRoot, toPosixRoot, underRoot } from "../utils/normalize-windows-path.ts";
import { resolveSpineDirectories } from "./spine.ts";

const MAX_RETAINED_SHARE = 0.9;

const WHOLE_MOUNT: ReadonlyArray<string> = [""];

/** Inputs for narrowing every mount. */
export interface NarrowMountsOptions {
	/** Where the walk reads. Defaults to the real filesystem. */
	fileSystem: FileSystem;
	/** Paths the shadow never carries, relative to the mount. */
	isCopyIgnored: CopyIgnoreMatcher;
	/** The project's `$path` mounts, in the same frame as the roots. */
	rojoMounts: ReadonlySet<string>;
	/** Absent means the run narrows nothing, so the mount is taken whole. */
	universe: InstrumentUniverse | undefined;
}

/** One rojo mount, split into what the shadow mirrors and the way down. */
export interface NarrowedMount {
	/** The canonical `luauRoot` this answer is for. */
	luauRoot: PosixRoot;
	/** Directories to instrument; empty when the universe never reaches it. */
	roots: Array<PosixRoot>;
	/** Directories from the mount down to the roots, roots excluded. */
	spine: Array<PosixRoot>;
}

type NarrowRootOptions = Except<NarrowMountsOptions, "rojoMounts">;

interface CarriedFiles {
	carried: Array<string>;
	hasIgnoredPaths: boolean;
}

/**
 * Narrow frame-relative roots to the directories the universe reaches.
 * @param roots - Frame-relative roots.
 * @param options - Narrowing inputs, `rojoMounts` absolute, and the absolute
 *   frame the roots are relative to.
 * @returns Narrowed mounts, frame-relative.
 */
export function narrowRootsInFrame(
	roots: ReadonlyArray<string>,
	{ frame, ...options }: NarrowMountsOptions & { frame: string },
): Array<NarrowedMount> {
	function toAbsolute(relative: string): PosixRoot {
		return toPosixRoot(path.join(frame, relative));
	}

	function toRelative(absolute: string): PosixRoot {
		return toPosixRoot(path.relative(frame, absolute));
	}

	return narrowLuauRoots(roots.map(toAbsolute), options).map((entry) => {
		return {
			luauRoot: toRelative(entry.luauRoot),
			roots: entry.roots.map(toRelative),
			spine: entry.spine.map(toRelative),
		};
	});
}

function carriedFiles({
	fileSystem,
	isCopyIgnored,
	luauRoot,
}: {
	fileSystem: FileSystem;
	isCopyIgnored: CopyIgnoreMatcher;
	luauRoot: PosixRoot;
}): CarriedFiles {
	const carried: Array<string> = [];
	let hasIgnoredPaths = false;
	walkLuauDirectory({
		directory: luauRoot,
		fileSystem,
		filter: {
			accept: () => true,
			skip: (relativePath) => {
				if (!isCopyIgnored(relativePath)) {
					return false;
				}

				hasIgnoredPaths = true;
				return true;
			},
		},
		results: carried,
	});
	return { carried, hasIgnoredPaths };
}

function probeDirectories(probed: ReadonlyArray<string>): Set<string> {
	const directories = new Set<string>();
	for (const relativePath of probed) {
		directories.add(path.posix.dirname(relativePath));
	}

	return directories;
}

function collapseToMaximal(candidates: ReadonlySet<string>): Array<string> {
	const ordered = [...candidates].toSorted();
	return ordered.filter((candidate) => {
		return ordered.every((other) => other === candidate || !isWithinRoot(candidate, other));
	});
}

function narrowRootToUniverse(
	luauRoot: PosixRoot,
	{ fileSystem, isCopyIgnored, universe }: NarrowRootOptions,
): Array<string> {
	if (universe === undefined) {
		return [...WHOLE_MOUNT];
	}

	const { carried, hasIgnoredPaths } = carriedFiles({ fileSystem, isCopyIgnored, luauRoot });
	const probed = carried.filter((relativePath) => {
		return (
			isInstrumentableFile(path.posix.basename(relativePath)) &&
			universe.includes(underRoot(luauRoot, relativePath))
		);
	});
	if (probed.some((relativePath) => !relativePath.includes("/"))) {
		return [...WHOLE_MOUNT];
	}

	// Dropping a mount the ignore list emptied would mount the unignored source.
	if (hasIgnoredPaths && probed.length === 0) {
		return [...WHOLE_MOUNT];
	}

	const roots = collapseToMaximal(probeDirectories(probed));
	const retained = carried.filter((relativePath) => {
		return roots.some((root) => isWithinRoot(relativePath, root));
	});
	if (retained.length > carried.length * MAX_RETAINED_SHARE) {
		return [...WHOLE_MOUNT];
	}

	return roots;
}

function isLoadable(roots: ReadonlyArray<string>, mounts: ReadonlySet<string>): boolean {
	return roots.every((root) => {
		return [...mounts].some((mount) => isWithinRoot(mount, root) || isWithinRoot(root, mount));
	});
}

function narrowLuauRoots(
	mounts: ReadonlyArray<PosixRoot>,
	options: NarrowMountsOptions,
): Array<NarrowedMount> {
	return mounts.map((mount) => {
		const narrowed = narrowRootToUniverse(mount, options).map((relative) => {
			return toPosixRoot(underRoot(mount, relative));
		});
		const roots = isLoadable(narrowed, options.rojoMounts) ? narrowed : [mount];
		return {
			luauRoot: mount,
			roots,
			spine: resolveSpineDirectories(roots, options.rojoMounts),
		};
	});
}
