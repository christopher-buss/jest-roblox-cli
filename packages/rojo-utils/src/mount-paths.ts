import { join, relative } from "node:path";

import type { RojoTreeNode } from "./rojo-types.ts";
import { isOptionalPath, isRojoTreeNode } from "./tree-node.ts";

const ABSOLUTE_MOUNT = /^(?:[/\\]|[A-Za-z]:[/\\])/;

/**
 * Every `$path` in the tree, optional mounts included, with backslashes
 * normalized.
 *
 * A mount is relative to the project file's directory unless the project wrote
 * it absolute, which is preserved as written.
 * @param node - Subtree to inspect without mutating it.
 * @param result - Caller-owned accumulator, appended in traversal order.
 */
export function collectPaths(node: RojoTreeNode, result: Array<string>): void {
	collectMountPaths({ node, options: { optional: true }, result });
}

/**
 * Appends required mounts only, normalizing backslashes.
 * @param node - Subtree to inspect without mutating it.
 * @param result - Caller-owned accumulator, appended in traversal order.
 */
export function collectRequiredPaths(node: RojoTreeNode, result: Array<string>): void {
	collectMountPaths({ node, options: { optional: false }, result });
}

/**
 * Whether a `$path` names a location on its own, rather than one relative to
 * the project file.
 *
 * Not `path.isAbsolute`, which answers for the host it runs on: `D:/out` and
 * `\out` both read as relative on Linux, so the same project file would resolve
 * to two different trees depending on which machine read it. Every root a
 * project can write is here — posix, drive, and the backslash forms Windows
 * uses for a drive-relative root and a UNC share.
 * @param value - Candidate from an existing parsed tree.
 * @returns Whether the mount has a POSIX, Windows drive or backslash root.
 */
export function isAbsoluteMount(value: string): boolean {
	return ABSOLUTE_MOUNT.test(value);
}

/**
 * {@link resolveMountPath}, with the separators left as written.
 * @param baseDirectory - Directory the mount is written against.
 * @param mount - Rojo mount, possibly absolute on a different host.
 * @returns The absolute mount as written, or its join with the project directory.
 */
export function resolveNativeMountPath(baseDirectory: string, mount: string): string {
	return isAbsoluteMount(mount) ? mount : join(baseDirectory, mount);
}

/**
 * The filesystem path a `$path` mount names, given the directory it is written
 * against — a project's own directory, or the root a mount was already rebased
 * onto. A `luauRoot` is written the same way and resolves through here too, so
 * a root and a mount are weighed on one rule.
 *
 * Joined, never resolved. `path.resolve` reads a drive-less absolute path
 * (`/external/out`) as drive-relative on Windows and answers with the base's
 * drive, so one mount names a different directory on each host; it also
 * resolves a relative `baseDirectory` against the process cwd, which is not a
 * frame any mount is written in. An absolute mount is already the location, so
 * it is joined onto nothing.
 *
 * Returns a posix-separated path with no trailing separator, matching what
 * {@link collectPaths} yields. A mount may be written `out/`, and `join` keeps
 * that slash where `resolve` ate it; every containment test downstream builds
 * its own `/` boundary, so a mount carrying one reads as inside nothing and
 * nothing reads as inside it.
 *
 * The drive letter is left as written, so a caller that compares two of these
 * canonicalizes both.
 * @param baseDirectory - Directory the mount is written against.
 * @param mount - Rojo mount, possibly absolute on a different host.
 * @returns The mount location with forward slashes, preserving absolute roots.
 */
export function resolveMountPath(baseDirectory: string, mount: string): string {
	return dropTrailingSlash(resolveNativeMountPath(baseDirectory, mount).replaceAll("\\", "/"));
}

/**
 * Copies a tree while expressing every mount against another root.
 * @param options - Subtree, its original project directory, and the new one.
 * @returns A new tree with mounts relative to the destination directory.
 */
export function rebaseTreePaths({
	fromDirectory,
	node,
	toDirectory,
}: {
	fromDirectory: string;
	node: RojoTreeNode;
	toDirectory: string;
}): RojoTreeNode {
	const result: RojoTreeNode = {};

	for (const [key, value] of Object.entries(node)) {
		if (key === "$path" && typeof value === "string") {
			const mountPath = resolveNativeMountPath(fromDirectory, value);
			result[key] = relative(toDirectory, mountPath).replaceAll("\\", "/");
			continue;
		}

		if (key === "$path" && isOptionalPath(value)) {
			const mountPath = resolveNativeMountPath(fromDirectory, value.optional);
			result[key] = { optional: relative(toDirectory, mountPath).replaceAll("\\", "/") };
			continue;
		}

		if (key.startsWith("$") || !isRojoTreeNode(value)) {
			result[key] = value;
			continue;
		}

		result[key] = rebaseTreePaths({ fromDirectory, node: value, toDirectory });
	}

	return result;
}

function collectMountPaths({
	node,
	options,
	result,
}: {
	node: RojoTreeNode;
	options: { optional: boolean };
	result: Array<string>;
}): void {
	for (const [key, value] of Object.entries(node)) {
		if (key === "$path" && typeof value === "string") {
			result.push(value.replaceAll("\\", "/"));
		} else if (key === "$path" && options.optional && isOptionalPath(value)) {
			result.push(value.optional.replaceAll("\\", "/"));
		} else if (!key.startsWith("$") && isRojoTreeNode(value)) {
			collectMountPaths({ node: value, options, result });
		}
	}
}

/**
 * Drop a trailing separator, unless it is the whole location: `/` is the posix
 * root and `D:/` a drive root, and a mount can name either.
 * @param mountPath - Normalized mount with a possible trailing separator.
 * @returns The path without its trailing slash, unless that slash denotes a root.
 */
function dropTrailingSlash(mountPath: string): string {
	if (!mountPath.endsWith("/")) {
		return mountPath;
	}

	const stripped = mountPath.slice(0, -1);
	return stripped === "" || stripped.endsWith(":") ? mountPath : stripped;
}
