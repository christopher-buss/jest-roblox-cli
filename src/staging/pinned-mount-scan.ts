import { isRojoTreeNode } from "@isentinel/rojo-utils";

import * as path from "node:path";

import { ConfigError } from "../config/errors.ts";
import type { RojoTreeNode } from "../types/rojo.ts";
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
	/**
	 * Name rojo would give the mounted instance, or `undefined` when the
	 * mount's own `$path` is the offender and the node already names it.
	 */
	childName: string | undefined;
	/** Absolute path to the offending file or directory. */
	source: string;
	/** The tree node whose `$path` reaches it. */
	target: RojoTreeNode;
}

/**
 * What the tree walk threads through every level: where to collect offenders,
 * which paths the project already drops, and which have been scanned already.
 * A node may carry both a `$path` and explicit children mounting paths inside
 * it, so without `scanned` one source is reached twice — and rebuilt twice,
 * with two rojo builds racing on one stand-in file.
 */
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
 * @throws {ConfigError} When a pinned class sits deeper than directly inside a mount.
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

/**
 * A directory entry as an absolute posix path, the frame every scan uses.
 * @param directory - Directory holding the entry.
 * @param entryName - Entry name within it.
 * @returns The joined posix path.
 */
function entryPathOf(directory: string, entryName: string): string {
	return path.posix.join(normalizeWindowsPath(directory), entryName);
}

/**
 * Whether a directory's own `init.meta.json` gives the instance rojo mounts for
 * it a class the engine pins.
 * @param options - The directory and its listing.
 * @param options.directory - Directory to check.
 * @param options.entries - The directory's entries.
 * @param options.fileSystem - Reads the meta file.
 * @returns True when the meta file declares a pinned class.
 */
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

/**
 * The name rojo gives a mounted entry: its basename, less the extension.
 * @param entryName - File or directory name.
 * @returns The name without a model extension.
 */
function mountedName(entryName: string): string {
	const lower = entryName.toLowerCase();
	const extension = MODEL_EXTENSIONS.find((candidate) => lower.endsWith(candidate));
	return extension === undefined ? entryName : entryName.slice(0, -extension.length);
}

/**
 * A class the engine pins is legal only directly under the one parent it is
 * pinned to, so a source tree that mirrors a working place always sits such a
 * file directly inside the mount for that parent. One buried deeper already
 * sits under the wrong parent in the consumer's own place, and no stand-in
 * this module writes would make it load — so it is reported rather than
 * rebuilt.
 * @param options - The directory to walk and its mount.
 * @param options.directory - Directory below the mount root.
 * @param options.entries - The directory's entries.
 * @param options.mountRoot - Mount path named in the error.
 * @param options.walk - File system and ignore matcher.
 * @throws {ConfigError} When an entry at any depth declares a pinned class.
 */
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

/**
 * One entry of an auto-mounted directory: a model file, or a directory whose
 * `init.meta.json` names the class. A directory that names none is walked only
 * to report a pinned class buried below it.
 * @param options - The entry and the mount it sits in.
 * @param options.entry - Entry directly inside the mount.
 * @param options.mountPath - Directory the mount reads.
 * @param options.target - Tree node whose `$path` is the mount.
 * @param options.walk - File system and ignore matcher.
 * @returns The offending mount, or `undefined`.
 * @throws {ConfigError} When a pinned class is buried below the entry.
 */
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
		// `init.meta.json` gives the class to the directory holding it, which the
		// caller has already asked about. Mounting it as a child of its own would
		// hand rojo a lone descriptor it cannot turn into an Instance.
		if (
			entry.name === META_JSON_FILE ||
			pinnedClassesOf(walk.fileSystem, entryPath).length === 0
		) {
			return undefined;
		}

		const name = mountedName(entry.name);
		return { name, childName: name, source: entryPath, target };
	}

	// One listing answers both questions — whether this directory declares a
	// class of its own, and what a deeper scan would walk. Probing for the meta
	// file by opening it would miss for nearly every directory in the tree, and
	// a failed open plus a thrown Error is the expensive way to ask.
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
	// The mount's own `init.meta.json` classes the instance rojo builds for the
	// whole mount, so a pinned one makes the mount itself the offender — the
	// node already names it, and no child stands in.
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
