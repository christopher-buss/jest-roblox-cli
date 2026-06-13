import { findInTree } from "@isentinel/rojo-utils";

import * as path from "node:path";

import type { ResolvedProjectConfig } from "../config/projects.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import type { BuildManifestProject } from "../coverage-pipeline/build-manifest.ts";
import type { RojoTreeNode } from "../types/rojo.ts";

/**
 * Map resolved project configs to the BuildManifest's per-project records. A
 * project can mount at several DataModel paths; each becomes its own entry so
 * the kernel resolves one project-root Instance per path. `setupFiles` /
 * `setupFilesAfterEnv` are already DataModel paths by the time projects resolve.
 */
export function toBuildManifestProjects(
	projects: Array<ResolvedProjectConfig>,
): Array<BuildManifestProject> {
	return projects.flatMap((project) => {
		return project.projects.map((projectDataModelPath) => {
			return {
				displayName: project.displayName,
				...(project.config.jestPath !== undefined
					? { jestDataModelPath: project.config.jestPath }
					: {}),
				projectDataModelPath,
				setupFiles: project.config.setupFiles ?? [],
				setupFilesAfterEnv: project.config.setupFilesAfterEnv ?? [],
				testMatch: project.testMatch,
			} satisfies BuildManifestProject;
		});
	});
}

/**
 * Single-project mode has no `ResolvedProjectConfig`, so derive one record per
 * luau root by mapping it through the rojo tree. Roots that don't map (e.g. a
 * compiled-output dir not mounted by the project) are skipped rather than
 * throwing, so a normal coverage run never breaks on an unmounted root.
 */
export function toSingleProjectManifest(
	config: ResolvedConfig,
	luauRoots: Array<string>,
	rojoTree: RojoTreeNode,
): Array<BuildManifestProject> {
	// `path.normalize` strips a trailing separator so `basename` doesn't return
	// "" for a `rootDir` like "/pkg/".
	const displayName = path.basename(path.normalize(config.rootDir));
	return luauRoots.flatMap((luauRoot) => {
		const projectDataModelPath = findInTree(rojoTree, luauRoot, "");
		if (projectDataModelPath === undefined) {
			return [];
		}

		return [
			{
				displayName,
				...(config.jestPath !== undefined ? { jestDataModelPath: config.jestPath } : {}),
				projectDataModelPath,
				setupFiles: config.setupFiles ?? [],
				setupFilesAfterEnv: config.setupFilesAfterEnv ?? [],
				testMatch: config.testMatch,
			} satisfies BuildManifestProject,
		];
	});
}
