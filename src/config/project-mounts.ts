import type { Mount, PathClassifier, PathKind, RojoTreeNode } from "@isentinel/rojo-utils";
import {
	collectMounts,
	collectPaths,
	findInTree,
	pruneAncestors,
	resolveMountPath,
} from "@isentinel/rojo-utils";

import * as path from "node:path";

import type { FileSystem } from "../utils/file-system.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import { toPosixRoot } from "../utils/normalize-windows-path.ts";
import type { ProjectTestConfig } from "./config-types.ts";
import { ConfigError } from "./errors.ts";

/**
 * Build a classifier that stats mount paths under a root directory.
 *
 * @param rootDirectory - Directory mount paths resolve against.
 * @param fileSystem - File system to stat.
 * @returns A classifier reporting `directory`, `file` or `missing`.
 */
export function createFsClassifier(rootDirectory: string, fileSystem: FileSystem): PathClassifier {
	return function classify(fsPath): PathKind {
		const stat = fileSystem.statSync(resolveMountPath(rootDirectory, fsPath), {
			throwIfNoEntry: false,
		});
		if (stat === undefined) {
			return "missing";
		}

		return stat.isDirectory() ? "directory" : "file";
	};
}

/**
 * Drop mounts whose DataModel path an earlier mount already holds.
 *
 * @param mounts - Mounts in priority order.
 * @returns The first mount per DataModel path, in order.
 */
export function dedupeMounts(mounts: Array<Mount>): Array<Mount> {
	const seen = new Set<string>();
	const result: Array<Mount> = [];
	for (const mount of mounts) {
		if (seen.has(mount.dataModelPath)) {
			continue;
		}

		seen.add(mount.dataModelPath);
		result.push(mount);
	}

	return result;
}

/**
 * Map a project's include roots, or its `outDir`, to Rojo mounts.
 *
 * @param options - Classifier, project, its display name, Rojo tree and
 *   include roots.
 * @returns The mounts, deduped and with ancestor-covered mounts pruned.
 * @throws {ConfigError} If a root or `outDir` maps to no Rojo entry.
 */
export function resolveMounts({
	classify,
	displayName,
	project,
	rojoTree,
	roots,
}: {
	/** Classifies file-system paths during auto-expand. */
	readonly classify: PathClassifier;
	/** Project name for error messages. */
	readonly displayName: string;
	/** Project whose mounts to resolve. */
	readonly project: ProjectTestConfig;
	/** Rojo project tree. */
	readonly rojoTree: RojoTreeNode;
	/** Include roots from `extractProjectRoots`. */
	readonly roots: Array<{
		/** Static directory prefix of the include patterns. */
		root: string;
		/** Luau-side patterns under `root`. */
		testMatch: Array<string>;
	}>;
}): Array<Mount> {
	if (project.outDir !== undefined) {
		const resolvedOutDirectory = joinProjectRoot(project.outDir, project.root);
		const dataModelPath = mapFsRootToDataModel(resolvedOutDirectory, rojoTree);
		return [{ dataModelPath, fsPath: resolvedOutDirectory }];
	}

	let collectedMounts: Array<Mount> | undefined;
	const allMounts: Array<Mount> = [];
	for (const { root } of roots) {
		const exact = findInTree({ currentDataModelPath: "", node: rojoTree, targetPath: root });
		if (exact !== undefined) {
			allMounts.push({ dataModelPath: exact, fsPath: root });
			continue;
		}

		collectedMounts ??= collectMounts({ classify, currentDataModelPath: "", node: rojoTree });
		const expanded = filterMountsForRoot(collectedMounts, root);
		if (expanded.length === 0) {
			throw unmappableRootError({ name: displayName, rojoTree, root });
		}

		allMounts.push(...expanded);
	}

	return pruneAncestorMounts(dedupeMounts(allMounts));
}

/**
 * Find the DataModel path a Rojo tree mounts a file-system directory at.
 *
 * @param outDirectory - Compiled-output directory to look up.
 * @param rojoTree - Rojo project tree.
 * @returns The DataModel path.
 * @throws {ConfigError} If no tree entry maps the directory.
 */
function mapFsRootToDataModel(outDirectory: PosixRoot, rojoTree: RojoTreeNode): string {
	const result = findInTree({
		currentDataModelPath: "",
		node: rojoTree,
		targetPath: outDirectory,
	});
	if (result === undefined) {
		const available: Array<string> = [];
		collectPaths(rojoTree, available);

		let message = `No Rojo tree mapping found for path: ${outDirectory}`;
		if (available.length > 0) {
			message += `\n\nAvailable $path entries: ${available.join(", ")}`;
		}

		const hint = outDirectory.startsWith("src/")
			? 'Path starts with "src/". If using roblox-ts, set "outDir" in your project config to the compiled output directory (e.g. "out/client")'
			: undefined;

		throw new ConfigError(message, hint);
	}

	return result;
}

function joinProjectRoot(relativePath: string, projectRoot: string | undefined): PosixRoot {
	return toPosixRoot(
		projectRoot !== undefined ? path.posix.join(projectRoot, relativePath) : relativePath,
	);
}

function pruneAncestorMounts(mounts: Array<Mount>): Array<Mount> {
	const dataModelPaths = mounts.map((mount) => mount.dataModelPath);
	const surviving = new Set(pruneAncestors(dataModelPaths));
	return mounts.filter((mount) => surviving.has(mount.dataModelPath));
}

function unmappableRootError({
	name,
	rojoTree,
	root,
}: {
	readonly name: string;
	readonly rojoTree: RojoTreeNode;
	readonly root: string;
}): ConfigError {
	const available: Array<string> = [];
	collectPaths(rojoTree, available);

	let message = `Project "${name}": include root "${root}" did not match any Rojo $path entry or subdirectory.`;
	if (available.length > 0) {
		message += `\n\nAvailable $path entries: ${available.join(", ")}`;
	}

	const hint = root.startsWith("src/")
		? 'Path starts with "src/". If using roblox-ts, set "outDir" in your project config to the compiled output directory (e.g. "out/client")'
		: undefined;

	return new ConfigError(message, hint);
}

function filterMountsForRoot(allMounts: Array<Mount>, root: string): Array<Mount> {
	return allMounts.filter((mount) => mount.fsPath.startsWith(`${root}/`));
}
