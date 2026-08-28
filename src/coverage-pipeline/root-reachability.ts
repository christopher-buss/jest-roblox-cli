import { collectPaths } from "@isentinel/rojo-utils";

import * as path from "node:path";

import type { RojoTreeNode } from "../types/rojo.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
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
