import { isOptionalPath, resolveMountPath } from "@isentinel/rojo-utils";
import type { RojoTreeNode } from "@isentinel/rojo-utils";

import * as path from "node:path";

import type { FileSystem } from "../utils/file-system.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import type { PathRedirect } from "./path-redirect.ts";
import { redirectPath } from "./path-redirect.ts";
import type { UnwrappedPackageDescriptor } from "./synthesizer-types.ts";
import { isTreeNode } from "./tree-node-guards.ts";

interface AbsolutizeOptions {
	fileSystem: FileSystem;
	redirects: ReadonlyArray<PathRedirect>;
	/** Spine directory by the absolute mount directory it stands in for. */
	spine: Map<string, string>;
}

/**
 * Make every `$path` in a package's tree absolute and redirected.
 * @param options - Package descriptor, file system and tree.
 * @param options.descriptor - Package whose redirects and spine apply.
 * @param options.fileSystem - Reads directories under demoted mounts.
 * @param options.node - Tree as the project file wrote it.
 * @returns A copy of the tree with absolute, redirected `$path` values.
 */
export function absolutizePackagePaths({
	descriptor,
	fileSystem,
	node,
}: {
	descriptor: UnwrappedPackageDescriptor;
	fileSystem: FileSystem;
	node: RojoTreeNode;
}): RojoTreeNode {
	return absolutizePaths({
		node,
		options: {
			fileSystem,
			redirects: descriptor.redirects ?? [],
			spine: new Map((descriptor.spine ?? []).map((entry) => [entry.from, entry.to])),
		},
		treeBase: path.dirname(descriptor.rojoProjectPath),
	});
}

function resolveDollarPath(absoluteTarget: string, options: AbsolutizeOptions): string {
	return redirectPath(absoluteTarget, options.redirects) ?? absoluteTarget;
}

function absolutizePaths({
	node,
	options,
	treeBase,
}: {
	node: RojoTreeNode;
	options: AbsolutizeOptions;
	treeBase: string;
}): RojoTreeNode {
	const result: RojoTreeNode = {};
	let mountTarget: string | undefined;
	for (const [key, value] of Object.entries(node)) {
		if (key === "$path" && typeof value === "string") {
			mountTarget = normalizeWindowsPath(resolveMountPath(treeBase, value));
			result[key] = resolveDollarPath(mountTarget, options);
			continue;
		}

		if (key === "$path" && isOptionalPath(value)) {
			mountTarget = normalizeWindowsPath(resolveMountPath(treeBase, value.optional));
			result[key] = { optional: resolveDollarPath(mountTarget, options) };
			continue;
		}

		if (!key.startsWith("$") && isTreeNode(value)) {
			result[key] = absolutizePaths({ node: value, options, treeBase });
			continue;
		}

		result[key] = value;
	}

	// After the loop, so a declared child wins over a demoted one.
	return mountTarget === undefined
		? result
		: demoteToSpine({ absoluteTarget: mountTarget, node: result, options });
}

function spineChildNode(absoluteTarget: string, options: AbsolutizeOptions): RojoTreeNode {
	return demoteToSpine({
		absoluteTarget,
		node: { $path: resolveDollarPath(absoluteTarget, options) },
		options,
	});
}

function demoteToSpine({
	absoluteTarget,
	node,
	options,
}: {
	absoluteTarget: string;
	node: RojoTreeNode;
	options: AbsolutizeOptions;
}): RojoTreeNode {
	const spineDirectory = options.spine.get(absoluteTarget);
	if (spineDirectory === undefined) {
		return node;
	}

	node.$path = spineDirectory;
	const entries = options.fileSystem.readdirSync(absoluteTarget, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith("$") || node[entry.name] !== undefined) {
			continue;
		}

		node[entry.name] = spineChildNode(path.posix.join(absoluteTarget, entry.name), options);
	}

	return node;
}
