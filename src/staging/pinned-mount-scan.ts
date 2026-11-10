import { isRojoTreeNode } from "@isentinel/rojo-utils";
import type { RojoTreeNode } from "@isentinel/rojo-utils";

import * as path from "node:path";

import { ConfigError } from "../config/errors.ts";
import type { Dirent, FileSystem } from "../utils/file-system.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { createIgnoreMatcher } from "./glob-ignore.ts";
import {
	isModelFile,
	META_JSON_FILE,
	MODEL_EXTENSIONS,
	readDeclaredClasses,
} from "./model-classes.ts";
import { PINNED_PARENT_CLASSES } from "./pinned-parent-classes.ts";

/** A model a staged `$path` would mount with a class the engine pins. */
export interface PinnedMount {
	/** Name rojo gives the offending instance. */
	name: string;
	/** Name of the mounted instance; `undefined` when the mount offends. */
	childName: string | undefined;
	/** Absolute path to the offending file or directory. */
	source: string;
	/** The tree node whose `$path` reaches it. */
	target: RojoTreeNode;
}

interface Walk {
	fileSystem: FileSystem;
	ignored: (absolutePath: string) => boolean;
	pinned: Array<PinnedMount>;
	scanned: Set<string>;
}

/**
 * Every staged mount that brings in a class the engine pins to one parent.
 * @param options - The stage tree and what the project ignores.
 * @param options.fileSystem - Reads the mounted files and directories.
 * @param options.globIgnorePaths - Patterns the project drops.
 * @param options.stage - Stage node whose `$path` mounts are scanned.
 * @returns The offending mounts, each scanned source once.
 * @throws {ConfigError} When a pinned class sits below a mount's top level.
 */
export function findPinnedMounts({
	fileSystem,
	globIgnorePaths,
	stage,
}: {
	fileSystem: FileSystem;
	globIgnorePaths: Array<string>;
	stage: RojoTreeNode;
}): Array<PinnedMount> {
	const pinned: Array<PinnedMount> = [];
	const ignored = createIgnoreMatcher(globIgnorePaths);
	collectPinnedMounts(stage, { fileSystem, ignored, pinned, scanned: new Set() });
	return pinned;
}

function pinnedClassesOf(fileSystem: FileSystem, filePath: string): Array<string> {
	return readDeclaredClasses(filePath, fileSystem).filter((declared) => {
		return PINNED_PARENT_CLASSES.has(declared);
	});
}

function entryPathOf(directory: string, entryName: string): string {
	return path.posix.join(normalizeWindowsPath(directory), entryName);
}

function declaresPinnedClass({
	directory,
	entries,
	fileSystem,
}: {
	directory: string;
	entries: ReadonlyArray<Dirent>;
	fileSystem: FileSystem;
}): boolean {
	const meta = entries.find((child) => child.name === META_JSON_FILE);
	if (meta === undefined || meta.isDirectory()) {
		return false;
	}

	return pinnedClassesOf(fileSystem, entryPathOf(directory, META_JSON_FILE)).length > 0;
}

function mountedName(entryName: string): string {
	const lower = entryName.toLowerCase();
	const extension = MODEL_EXTENSIONS.find((candidate) => lower.endsWith(candidate));
	return extension === undefined ? entryName : entryName.slice(0, -extension.length);
}

function assertNoDeeperPinnedClass({
	directory,
	entries,
	mountRoot,
	walk,
}: {
	directory: string;
	entries: ReadonlyArray<Dirent>;
	mountRoot: string;
	walk: Walk;
}): void {
	for (const entry of entries) {
		const entryPath = entryPathOf(directory, entry.name);
		if (walk.ignored(entryPath)) {
			continue;
		}

		if (entry.isDirectory()) {
			assertNoDeeperPinnedClass({
				directory: entryPath,
				entries: walk.fileSystem.readdirSync(entryPath, { withFileTypes: true }),
				mountRoot,
				walk,
			});
			continue;
		}

		const [buried] = pinnedClassesOf(walk.fileSystem, entryPath);
		if (buried !== undefined) {
			throw new ConfigError(
				`"${entryPath}" declares ${buried}, which the engine parents only under one service, but it is nested inside the mount at "${mountRoot}" rather than sitting directly in it. ` +
					"Roblox rejects it wherever that mount lands, so move the file up to the directory mounted at its own service, or drop it from the project with `globIgnorePaths`.",
			);
		}
	}
}

function collectDirectoryEntry({
	entry,
	mountPath,
	target,
	walk,
}: {
	entry: Dirent;
	mountPath: string;
	target: RojoTreeNode;
	walk: Walk;
}): PinnedMount | undefined {
	const entryPath = entryPathOf(mountPath, entry.name);
	if (walk.ignored(entryPath)) {
		return undefined;
	}

	if (!entry.isDirectory()) {
		if (
			entry.name === META_JSON_FILE ||
			pinnedClassesOf(walk.fileSystem, entryPath).length === 0
		) {
			return undefined;
		}

		const name = mountedName(entry.name);
		return { name, childName: name, source: entryPath, target };
	}

	const entries = walk.fileSystem.readdirSync(entryPath, { withFileTypes: true });
	if (declaresPinnedClass({ directory: entryPath, entries, fileSystem: walk.fileSystem })) {
		const name = mountedName(entry.name);
		return { name, childName: name, source: entryPath, target };
	}

	assertNoDeeperPinnedClass({ directory: entryPath, entries, mountRoot: mountPath, walk });
	return undefined;
}

function ownMount(mountPath: string, target: RojoTreeNode): PinnedMount {
	return {
		name: mountedName(path.basename(mountPath)),
		childName: undefined,
		source: mountPath,
		target,
	};
}

function collectMountEntries({
	mountPath,
	target,
	walk,
}: {
	mountPath: string;
	target: RojoTreeNode;
	walk: Walk;
}): void {
	const key = normalizeWindowsPath(mountPath);
	if (walk.ignored(mountPath) || walk.scanned.has(key)) {
		return;
	}

	walk.scanned.add(key);

	if (isModelFile(mountPath)) {
		if (pinnedClassesOf(walk.fileSystem, mountPath).length > 0) {
			walk.pinned.push(ownMount(mountPath, target));
		}

		return;
	}

	const stats = walk.fileSystem.statSync(mountPath, { throwIfNoEntry: false });
	if (stats?.isDirectory() !== true) {
		return;
	}

	const entries = walk.fileSystem.readdirSync(mountPath, { withFileTypes: true });
	if (declaresPinnedClass({ directory: mountPath, entries, fileSystem: walk.fileSystem })) {
		walk.pinned.push(ownMount(mountPath, target));
		return;
	}

	for (const entry of entries) {
		const mount = collectDirectoryEntry({ entry, mountPath, target, walk });
		if (mount !== undefined) {
			walk.pinned.push(mount);
		}
	}
}

function collectPinnedMounts(node: RojoTreeNode, walk: Walk): void {
	const mountPath = node.$path;
	if (typeof mountPath === "string") {
		collectMountEntries({ mountPath, target: node, walk });
	}

	for (const [key, value] of Object.entries(node)) {
		if (!key.startsWith("$") && isRojoTreeNode(value)) {
			collectPinnedMounts(value, walk);
		}
	}
}
