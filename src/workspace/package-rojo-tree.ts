import { loadRojoProject, rebaseTreePaths } from "@isentinel/rojo-utils";

import * as path from "node:path";

import type { RojoTreeNode } from "../types/rojo.ts";

/**
 * Load a package's Rojo tree with every `$path` expressed relative to the
 * package directory.
 *
 * `loadRojoProject` resolves nested projects and expresses every `$path`
 * relative to the project file's directory. Include roots, however, resolve
 * relative to the package directory. When the project file lives in a
 * subdirectory (e.g. `test/default.project.json`) the two bases diverge, so
 * rebase the tree to package-relative paths so mount resolution (findInTree /
 * collectMounts) compares like-for-like.
 */
export function loadPackageRojoTree(
	rojoProjectPath: string,
	packageDirectory: string,
): RojoTreeNode {
	const rojoDirectory = path.dirname(rojoProjectPath);
	const project = loadRojoProject(rojoProjectPath);
	return rebaseTreePaths(project.tree, rojoDirectory, packageDirectory);
}
