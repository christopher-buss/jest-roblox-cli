import * as path from "node:path";

import { toPosixRoot } from "../utils/normalize-windows-path.ts";
import type { CopyIgnoreMatcher } from "./discover-files.ts";
import { isInstrumentableFile, walkLuauDirectory } from "./discover-files.ts";
import type { InstrumentUniverse } from "./instrument-universe.ts";
import { isWithinRoot } from "./redirect-path.ts";
import { resolveSpineDirectories } from "./spine.ts";

/**
 * How much of a mount narrowing is allowed to keep and still be worth taking.
 *
 * Narrowing never copies more than the mount does, so this bounds the other
 * cost: every directory the shadow stops holding becomes a project node the
 * synthesized place carries, and a config whose covered files are scattered
 * one per directory collapses to roots that hold nearly the whole mount —
 * paying for the nodes and saving nothing.
 *
 * Measured on `anime-rush`, where the two shapes sit either side of this.
 * Its `out/shared` narrows to 5% of the mount, and its `out/server` to 80%;
 * taking both is 697 shadow files and a 1341 ms cold prepare against 760 and
 * 1450 ms for `out/shared` alone, so a mount that still sheds a fifth is
 * worth narrowing. A tuning surface, not an architectural constant.
 */
const MAX_RETAINED_SHARE = 0.9;

/** The mount taken whole, which is what every non-narrowing answer is. */
const WHOLE_MOUNT: ReadonlyArray<string> = [""];

export interface NarrowRootOptions {
	/** Paths the shadow never carries, relative to the mount. */
	isCopyIgnored: CopyIgnoreMatcher;
	/** Absent means the run narrows nothing, so the mount is taken whole. */
	universe: InstrumentUniverse | undefined;
}

export interface NarrowMountsOptions extends NarrowRootOptions {
	/**
	 * The project's `$path` mounts, in the same frame as the roots. Only a
	 * directory the place actually mounts is one a demote can rewrite, and a
	 * `luauRoot` need not be one — it can sit above the mounts, or below.
	 */
	rojoMounts: ReadonlySet<string>;
}

/** One rojo mount, split into what the shadow mirrors and the way down. */
export interface NarrowedMount {
	/**
	 * The `luauRoot` this answer is for, canonical: forward slashes and no
	 * trailing separator, so it composes with the paths beside it. Not
	 * necessarily a `$path` mount — a root can sit above the mounts, or below.
	 */
	luauRoot: string;
	/**
	 * Directories to instrument, in the mount's own frame. Empty for a mount
	 * the universe never reaches, which the place then loads unmodified.
	 */
	roots: Array<string>;
	/**
	 * Directories between the mount and the roots, the mount first and the
	 * roots excluded. The shadow carries their own loose files so the place
	 * can mount them and hang the roots underneath.
	 */
	spine: Array<string>;
}

/** One mount's walk: what the shadow would carry, and what the list refused. */
interface CarriedFiles {
	carried: Array<string>;
	hasIgnoredPaths: boolean;
}

/**
 * Narrow one rojo mount to the directories the coverage universe actually
 * resolves to.
 *
 * A `--coverage` run mirrors every file under a mount into the shadow, because
 * the rojo `$path` swap is directory-granular. Most of those files carry no
 * probes and are byte-identical to what the compiler already wrote, so the
 * mirror is the largest cost in a cold prepare. Deriving the roots from where
 * the universe resolves — rather than from the mount, or from the static prefix
 * of the globs — leaves the shadow holding the probed subtrees and the way down
 * to them.
 *
 * The universe is resolvable before anything is instrumented: the walk reads
 * directory entries only, and the universe gate reads source maps. So the
 * discovery pass this makes is the same one instrumentation would have made.
 */
export function narrowRootToUniverse(
	luauRoot: string,
	{ isCopyIgnored, universe }: NarrowRootOptions,
): Array<string> {
	if (universe === undefined) {
		return [...WHOLE_MOUNT];
	}

	const posixRoot = toPosixRoot(luauRoot);
	const { carried, hasIgnoredPaths } = carriedFiles(posixRoot, isCopyIgnored);
	const probed = carried.filter((relativePath) => {
		return (
			isInstrumentableFile(path.posix.basename(relativePath)) &&
			universe.includes(`${posixRoot}/${relativePath}`)
		);
	});
	// A probe sitting directly in the mount makes the mount its own probe
	// directory, and nothing narrower can hold it. A mount with no probe at all
	// falls out of the collapse below as no roots, which is the same answer.
	if (probed.some((relativePath) => !relativePath.includes("/"))) {
		return [...WHOLE_MOUNT];
	}

	// A mount the ignore list emptied is not a mount the universe never
	// reached, and only the second is safe to leave alone. No probe survives to
	// narrow towards, so the mount is taken whole: the shadow it earns is the
	// only tree the ignored path is missing from, and dropping it would mount
	// the source and hand the place back what the pattern excluded.
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

/**
 * Narrow every rojo mount, keeping each one's answer beside the mount it came
 * from — the spine is only meaningful against the mount it descends from, and
 * `coverageCopyIgnorePatterns` is written relative to that same directory.
 */
export function narrowLuauRoots(
	mounts: ReadonlyArray<string>,
	options: NarrowMountsOptions,
): Array<NarrowedMount> {
	return mounts.map((mount) => {
		const frame = toPosixRoot(mount);
		const narrowed = narrowRootToUniverse(mount, options).map((relative) => {
			return relative === "" ? frame : `${frame}/${relative}`;
		});
		const roots = isLoadable(narrowed, options.rojoMounts) ? narrowed : [frame];
		return {
			luauRoot: frame,
			roots,
			spine: resolveSpineDirectories(roots, options.rojoMounts),
		};
	});
}

/**
 * Every file the shadow would carry for this mount, mount-relative, and whether
 * the ignore list refused anything on the way.
 *
 * The whole set, not just the probed half: the share the threshold reads is a
 * share of the copying, and a spec file or a `.meta.json` costs the same to
 * copy as a module. Copy-ignored paths are left out because the shadow never
 * holds them either way — which is exactly why the walk has to say it saw them.
 * Nothing downstream can tell a mount the list emptied from one that was empty.
 */
function carriedFiles(posixRoot: string, isCopyIgnored: CopyIgnoreMatcher): CarriedFiles {
	const carried: Array<string> = [];
	let hasIgnoredPaths = false;
	walkLuauDirectory(
		posixRoot,
		posixRoot,
		{
			accept: () => true,
			skip: (relativePath) => {
				if (!isCopyIgnored(relativePath)) {
					return false;
				}

				hasIgnoredPaths = true;
				return true;
			},
		},
		carried,
	);
	return { carried, hasIgnoredPaths };
}

/** The directories that directly hold a probed file, mount-relative. */
function probeDirectories(probed: ReadonlyArray<string>): Set<string> {
	const directories = new Set<string>();
	for (const relativePath of probed) {
		directories.add(path.posix.dirname(relativePath));
	}

	return directories;
}

/**
 * Drop every candidate that sits inside another. The shadow mirrors a root's
 * whole subtree, so a nested pair would copy everything under the child twice
 * and mount it twice.
 */
function collapseToMaximal(candidates: ReadonlySet<string>): Array<string> {
	const ordered = [...candidates].toSorted();
	return ordered.filter((candidate) => {
		return ordered.every((other) => other === candidate || !isWithinRoot(candidate, other));
	});
}

/**
 * Whether the place can be made to load every one of these roots.
 *
 * A root earns that from a `$path` mount landing on it — redirected outright —
 * or from one above it, which is demoted onto a spine copy instead. A root with
 * neither is instrumented into a shadow nothing mounts, which is coverage that
 * comes back empty with no sign of why. Narrowing gives that up rather than
 * risk it: the mount it started from was reachable by construction, so falling
 * back to it costs copying, not correctness.
 *
 * The live way in is a rojo project this run could not read — a mount set it
 * cannot see is one it cannot demote against.
 */
function isLoadable(roots: ReadonlyArray<string>, mounts: ReadonlySet<string>): boolean {
	return roots.every((root) => {
		return [...mounts].some((mount) => isWithinRoot(mount, root) || isWithinRoot(root, mount));
	});
}
