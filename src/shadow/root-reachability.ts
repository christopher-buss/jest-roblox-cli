import { collectPaths, resolveMountPath } from "@isentinel/rojo-utils";
import type { RojoTreeNode } from "@isentinel/rojo-utils";

import * as path from "node:path";
import process from "node:process";

import type { FileSystem } from "../utils/file-system.ts";
import {
	isWithinRoot,
	normalizeWindowsPath,
	relativeToRoot,
	toPosixRoot,
} from "../utils/normalize-windows-path.ts";

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

/** Where a rojo `$path` is read from, and the frame of the answer. */
export interface MountFrame {
	/** What a coverage root is written relative to. */
	frame: string;
	/** What a `$path` resolves against: the rojo project's own directory. */
	rojoDirectory: string;
}

/**
 * Whether a directory tree holds a file whose name `matches` accepts.
 * @param fileSystem - File system to walk.
 * @param search - Directory to walk and the file-name test.
 * @param search.directoryPath - Directory to walk.
 * @param search.matches - Accepts a file name.
 * @returns True when some file under the directory matches.
 */
export function containsMatchingFile(
	fileSystem: FileSystem,
	{ directoryPath, matches }: { directoryPath: string; matches: (name: string) => boolean },
): boolean {
	const entries = fileSystem.readdirSync(directoryPath, { withFileTypes: true });
	return entries.some((entry) => {
		if (entry.isFile() && matches(entry.name)) {
			return true;
		}

		if (entry.isDirectory()) {
			return containsMatchingFile(fileSystem, {
				directoryPath: path.join(directoryPath, entry.name),
				matches,
			});
		}

		return false;
	});
}

/**
 * Every `$path` mount in a rojo tree, absolute.
 * @param tree - Loaded rojo project tree.
 * @param rojoDirectory - Directory holding the rojo project.
 * @returns Normalized absolute mount paths.
 */
export function collectRojoMounts(tree: RojoTreeNode, rojoDirectory: string): Set<string> {
	const collected: Array<string> = [];
	collectPaths(tree, collected);

	// Roots compared against these also pass through `normalizeWindowsPath`.
	return new Set(
		collected.map((rawPath) => {
			return normalizeWindowsPath(resolveMountPath(inCwdFrame(rojoDirectory), rawPath));
		}),
	);
}

/**
 * The warning for a `luauRoot` no `$path` mount reaches, or `undefined`.
 * @param reachability - The root, its base, the mounts and the declaring
 * subject.
 * @returns Warning text, or `undefined` when a mount reaches the root.
 */
export function unreachableRootWarning({
	base,
	mounts,
	rawRoot,
	subject,
}: RootReachability): string | undefined {
	// Must resolve exactly as `collectRojoMounts` resolves the mounts.
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
 * A rojo `$path` as a root relative to `frame`, or `undefined` outside it.
 * @param rawPath - The `$path` as written in the project.
 * @param mountFrame - The frame and the rojo project directory.
 * @returns Root relative to the frame, or `undefined` when outside it or equal
 * to it.
 */
export function resolveMountWithin(
	rawPath: string,
	{ frame, rojoDirectory }: MountFrame,
): string | undefined {
	const base = toPosixRoot(inCwdFrame(frame));
	// Must resolve exactly as `collectRojoMounts` resolves the same `$path`.
	const absolute = toPosixRoot(resolveMountPath(inCwdFrame(rojoDirectory), rawPath));
	// Not `path.relative`: it resolves a file-system-root frame against cwd.
	return absolute === base ? undefined : relativeToRoot(base, absolute);
}

function inCwdFrame(directory: string): string {
	return resolveMountPath(normalizeWindowsPath(process.cwd()), directory);
}
