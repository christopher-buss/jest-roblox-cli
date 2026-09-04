import { collectPaths, resolveMountPath } from "@isentinel/rojo-utils";

import process from "node:process";

import type { RojoTreeNode } from "../types/rojo.ts";
import {
	normalizeWindowsPath,
	relativeToRoot,
	toPosixRoot,
} from "../utils/normalize-windows-path.ts";
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

	// Drive letter upper-cased on top of the mount rule: every root these are
	// weighed against arrives through `normalizeWindowsPath`, and two spellings
	// of one drive compare unequal.
	return new Set(
		collected.map((rawPath) => {
			return normalizeWindowsPath(resolveMountPath(inCwdFrame(rojoDirectory), rawPath));
		}),
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
	// Resolved exactly as the mounts were. A root and a mount only ever meet
	// here, so a rule that differs by side answers "does not reach" for two
	// spellings of one directory.
	const root = normalizeWindowsPath(resolveMountPath(inCwdFrame(base), rawRoot));
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
	const base = toPosixRoot(inCwdFrame(frame));
	// Resolved exactly as {@link collectRojoMounts} resolves the same `$path`:
	// a root is weighed against that mount set, so a second reading of what
	// "absolute" means would let a root and the mount it came from disagree.
	const absolute = toPosixRoot(resolveMountPath(inCwdFrame(rojoDirectory), rawPath));
	// The frame is what roots are written from, not a root within it, so it
	// does not name one itself. `relativeToRoot` answers for the rest —
	// including a frame that is a file-system root, where `path.relative`
	// would resolve the root against the cwd instead.
	return absolute === base ? undefined : relativeToRoot(base, absolute);
}

/**
 * A directory in the frame every mount here is stated in.
 *
 * A rojo directory arrives relative whenever the project was named relative —
 * `path.dirname("default.project.json")` is `"."` — and a mount joined onto
 * that is relative too, so it could never sit inside an absolute frame and the
 * whole project would report no roots. The cwd is what a relative one is
 * written against, and `resolveMountPath` leaves an absolute one alone.
 */
function inCwdFrame(directory: string): string {
	return resolveMountPath(normalizeWindowsPath(process.cwd()), directory);
}
