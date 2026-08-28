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

	// path.resolve passes an absolute rawPath through and resolves a relative
	// one against the rojo dir, so no isAbsolute branch is needed.
	return new Set(
		collected.map((rawPath) => normalizeWindowsPath(path.resolve(rojoDirectory, rawPath))),
	);
}

/**
 * The warning for a `luauRoot` the place will never load, or `undefined` when
 * the root is good. A root earns its coverage through the `$path` mounts that
 * land on it or inside it, because those are the mounts synthesis redirects
 * into the shadow tree — so the test is `isWithinRoot`, the redirect's own
 * rule, and a root this accepts is one the synthesized place picks up.
 *
 * A root *below* its mount fails that test. Synthesis rewrites a `$path` at or
 * inside a coverage root and nothing else, so the mount above keeps pointing
 * at the original sources: the shadow is built, never loaded, and the report
 * comes back empty.
 */
export function unreachableRootWarning({
	base,
	mounts,
	rawRoot,
	subject,
}: RootReachability): string | undefined {
	const root = normalizeWindowsPath(path.resolve(base, rawRoot));
	let containing: string | undefined;
	for (const mount of mounts) {
		if (isWithinRoot(mount, root)) {
			return undefined;
		}

		if (!isWithinRoot(root, mount)) {
			continue;
		}

		// Deepest wins: with both `src` and `src/a` above `src/a/b`, `src/a`
		// is the one that actually shadows the root. Two mounts above one root
		// nest, so "deeper" is "inside the incumbent" — which keeps the
		// message off the mount set's iteration order.
		if (containing === undefined || isWithinRoot(mount, containing)) {
			containing = mount;
		}
	}

	const owner = subject === undefined ? "" : ` in ${subject}`;
	if (containing === undefined) {
		return `Warning: luauRoot "${rawRoot}"${owner} does not correspond to any rojo $path mount, so it reports no coverage.\n`;
	}

	// Named in the frame the root was written in, so the reader can find it in
	// their own `.project.json`. The remedy stays generic rather than "widen to
	// <mount>": a mount above `base` relativizes to a `..` path the caller
	// would turn away, so quoting it back as advice would misdirect.
	const mount = normalizeWindowsPath(path.relative(base, containing));
	return `Warning: luauRoot "${rawRoot}"${owner} sits below the rojo $path mount "${mount}", which the place loads unmodified, so it reports no coverage. Point the root at a mount, or mount "${rawRoot}" in the rojo project.\n`;
}
