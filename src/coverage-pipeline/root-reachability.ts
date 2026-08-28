import { collectPaths } from "@isentinel/rojo-utils";

import * as path from "node:path";

import type { RojoTreeNode } from "../types/rojo.ts";
import { normalizeWindowsPath, toPosixRoot } from "../utils/normalize-windows-path.ts";
import { isWithinRoot } from "./redirect-path.ts";

/** One `luauRoots` entry, weighed against a project's rojo `$path` mounts. */
export interface RootReachability {
	/** What `rawRoot` resolves against, and the frame the warning speaks in. */
	base: string;
	/** Absolute mounts, from {@link collectRojoMounts}. */
	mounts: Set<string>;
	/** The entry as the user wrote it, echoed back in the warning. */
	rawRoot: string;
	/** Who declared the entry. Named in the warning when the mode has one. */
	subject?: string | undefined;
}

/**
 * Where a rojo `$path` is read from, and the frame the answer is written in.
 */
export interface MountFrame {
	/**
	 * What a coverage root is written relative to: the package directory in
	 * workspace mode, `rootDir` in single and multi mode. Both are the same
	 * thing — synthesis resolves a root against the package directory, and a
	 * single-mode run is one synthetic package rooted at `rootDir`.
	 */
	frame: string;
	/** What a `$path` resolves against — the rojo project's own directory. */
	rojoDirectory: string;
}

/**
 * Every `$path` mount in a rojo tree, absolute. Rojo resolves a `$path`
 * against the project's own directory, and so does synthesis, so a mount set
 * built against anything else would describe a place we do not build.
 *
 * Takes the loaded tree rather than a path so a caller that already read the
 * project does not read it twice.
 */
export function collectRojoMounts(tree: RojoTreeNode, rojoDirectory: string): Set<string> {
	const collected: Array<string> = [];
	collectPaths(tree, collected);

	// path.resolve passes a host-absolute rawPath through and resolves a
	// relative one against the rojo dir, so no isAbsolute branch is needed. It
	// stamps this host's drive onto a drive-less absolute path, which changes
	// nothing here: every root it is weighed against is resolved the same way.
	return new Set(
		collected.map((rawPath) => normalizeWindowsPath(path.resolve(rojoDirectory, rawPath))),
	);
}

/**
 * The warning for a `luauRoot` no `$path` in the project reaches, or
 * `undefined` when the root is good.
 *
 * A root earns its coverage two ways. A mount that lands on it or inside it is
 * redirected into the shadow outright. A mount *above* it is demoted instead:
 * that mount's `$path` moves onto a spine copy and the root hangs underneath
 * as an explicit child. Either direction of containment reaches the root, so
 * only one standing off the tree altogether reports nothing.
 */
export function unreachableRootWarning({
	base,
	mounts,
	rawRoot,
	subject,
}: RootReachability): string | undefined {
	const root = normalizeWindowsPath(path.resolve(base, rawRoot));
	const isReached = [...mounts].some((mount) => {
		return isWithinRoot(mount, root) || isWithinRoot(root, mount);
	});
	if (isReached) {
		return undefined;
	}

	const owner = subject === undefined ? "" : ` in ${subject}`;
	return `Warning: luauRoot "${rawRoot}"${owner} does not correspond to any rojo $path mount, so it reports no coverage.\n`;
}

/**
 * A rojo `$path` as a coverage root inside `frame`, or `undefined` when it
 * lands outside one.
 *
 * The question every mode asks of a mount before taking it as a root, so that
 * they cannot answer it differently. Whether the `$path` is written absolute
 * is not the question: an absolute one under the frame names a root the shadow
 * can mirror, and a relative `../outside/out` names one it cannot.
 *
 * Judged on the resolved path, not the spelling — `src/..` names the frame and
 * a directory honestly called `..cache` does not escape it.
 */
export function resolveMountWithin(
	rawPath: string,
	{ frame, rojoDirectory }: MountFrame,
): string | undefined {
	// `toPosixRoot`, because `isWithinRoot` reads the separator itself and a
	// frame that resolves to a filesystem root (`/`, `C:/`) is the one path
	// `path.resolve` leaves a trailing one on — which would weigh every child
	// against `//` and reject the lot.
	const base = toPosixRoot(path.resolve(frame));
	// Resolved exactly as {@link collectRojoMounts} resolves the same `$path`,
	// host-dependent absoluteness included: a root is weighed against that
	// mount set, so a second reading of what "absolute" means would let a root
	// and the mount it came from disagree.
	const absolute = toPosixRoot(path.resolve(rojoDirectory, rawPath));
	// `isWithinRoot` admits the root itself, hence the inequality: the frame is
	// what roots are written from, not a root within it.
	if (absolute === base || !isWithinRoot(absolute, base)) {
		return undefined;
	}

	// Sliced rather than relativized: at a filesystem root `base` is the empty
	// string, which `path.relative` would resolve against the cwd instead.
	return absolute.slice(base.length + 1);
}
