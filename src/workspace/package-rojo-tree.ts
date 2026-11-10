import { loadRojoProject, rebaseTreePaths } from "@isentinel/rojo-utils";
import type { RojoTreeNode } from "@isentinel/rojo-utils";

import * as path from "node:path";

import type { FileSystem } from "../utils/file-system.ts";

/**
 * Load a package's Rojo tree with `$path` values relative to the package.
 * @param options - Package directory, project file and file system.
 * @param options.fileSystem - File system to read through.
 * @param options.packageDirectory - Base for the rebased paths.
 * @param options.rojoProjectPath - Rojo project file to load.
 * @returns The tree with package-relative `$path` values.
 */
export function loadPackageRojoTree({
	fileSystem,
	packageDirectory,
	rojoProjectPath,
}: {
	readonly fileSystem?: FileSystem;
	readonly packageDirectory: string;
	readonly rojoProjectPath: string;
}): RojoTreeNode {
	const rojoDirectory = path.dirname(rojoProjectPath);
	const project = loadRojoProject(rojoProjectPath, fileSystem);
	return rebaseTreePaths({
		fromDirectory: rojoDirectory,
		node: project.tree,
		toDirectory: packageDirectory,
	});
}
