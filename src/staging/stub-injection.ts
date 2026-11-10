import type { RojoTreeNode } from "@isentinel/rojo-utils";

import * as path from "node:path";

import { ConfigError } from "../config/errors.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { STUB_FILENAMES } from "./stub-files.ts";
import type { StubMount } from "./synthesizer-types.ts";
import { isTreeNode } from "./tree-node-guards.ts";

const STUB_INJECTION_KEY = "jest.config";

/**
 * Mount each stub as a `jest.config` child at its DataModel path.
 * @param options - The tree and the stubs to mount in it.
 * @param options.fileSystem - Reads directories demoted on the way down.
 * @param options.root - Synthesized tree; mutated.
 * @param options.stubMounts - Stubs to mount, if any.
 * @returns The user config files the stubs replace, as POSIX paths.
 * @throws {ConfigError} When a path does not resolve or a `jest.config`
 *   already exists there.
 */
export function injectStubMounts({
	fileSystem,
	root,
	stubMounts,
}: {
	fileSystem: FileSystem;
	root: RojoTreeNode;
	stubMounts: Array<StubMount> | undefined;
}): Array<string> {
	if (!stubMounts) {
		return [];
	}

	const replaced: Array<string> = [];
	const injected = new Map<RojoTreeNode, string>();
	for (const mount of stubMounts) {
		const leaf = walkToLeaf({ dataModelPath: mount.dataModelPath, fileSystem, root });
		const stubPath = normalizeWindowsPath(mount.absStubPath);
		if (injected.get(leaf) === stubPath) {
			continue;
		}

		replaced.push(...findSourceConfigs(fileSystem, leaf));
		if (leaf[STUB_INJECTION_KEY] !== undefined) {
			throw new ConfigError(
				`stubMount at "${mount.dataModelPath}" would overwrite an existing "${STUB_INJECTION_KEY}" child already declared in the project tree. ` +
					"Remove the explicit declaration from your .project.json.",
			);
		}

		leaf[STUB_INJECTION_KEY] = { $path: stubPath };
		injected.set(leaf, stubPath);
	}

	return replaced;
}

function demoteAutoMountToExplicit({
	fileSystem,
	parent,
	parentPath,
}: {
	fileSystem: FileSystem;
	parent: RojoTreeNode;
	parentPath: string;
}): void {
	const entries = fileSystem.readdirSync(parentPath, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.name.startsWith("$")) {
			continue;
		}

		if (parent[entry.name] !== undefined) {
			continue;
		}

		// Rojo hard-errors on a `$path` file with an unknown extension.
		if (!entry.isDirectory()) {
			continue;
		}

		const entryPath = path.posix.join(parentPath, entry.name);
		parent[entry.name] = { $path: normalizeWindowsPath(entryPath) };
	}

	delete parent.$path;
	parent.$className ??= "Folder";
}

function virtualizePathChild({
	fileSystem,
	parent,
	segment,
}: {
	fileSystem: FileSystem;
	parent: RojoTreeNode;
	segment: string;
}): RojoTreeNode | undefined {
	const parentPath = parent.$path;
	if (typeof parentPath !== "string") {
		return undefined;
	}

	const childPath = path.posix.join(parentPath, segment);
	const stat = fileSystem.statSync(childPath, { throwIfNoEntry: false });
	if (stat?.isDirectory() !== true) {
		return undefined;
	}

	// Rojo does not merge a `$path` auto-mount with a same-named explicit
	// child; it builds a duplicate sibling instead.
	demoteAutoMountToExplicit({ fileSystem, parent, parentPath });

	const child = parent[segment];
	return isTreeNode(child) ? child : undefined;
}

function walkToLeaf({
	dataModelPath,
	fileSystem,
	root,
}: {
	dataModelPath: string;
	fileSystem: FileSystem;
	root: RojoTreeNode;
}): RojoTreeNode {
	let cursor = root;
	for (const segment of dataModelPath.split("/")) {
		let next = cursor[segment];
		if (!isTreeNode(next)) {
			next = virtualizePathChild({ fileSystem, parent: cursor, segment });
		}

		if (!isTreeNode(next)) {
			throw new ConfigError(
				`stubMount dataModelPath "${dataModelPath}" does not resolve in synthesized tree (missing segment "${segment}")`,
			);
		}

		cursor = next;
	}

	return cursor;
}

function findSourceConfigs(fileSystem: FileSystem, leaf: RojoTreeNode): Array<string> {
	const leafPath = leaf.$path;
	if (typeof leafPath !== "string") {
		return [];
	}

	return Array.from(STUB_FILENAMES, (candidate) => path.join(leafPath, candidate))
		.filter((sourceFile) => fileSystem.existsSync(sourceFile))
		.map(normalizeWindowsPath);
}
