import type { LoadedRojoProject } from "@isentinel/rojo-utils";
import { tryLoadRojoProject } from "@isentinel/rojo-utils";

import * as path from "node:path";

import type { ResolvedConfig } from "../config/resolved-config.ts";
import type { FileSystem } from "../utils/file-system.ts";

/** A project's Rojo project, as the best-effort executor readers see it. */
export type ProjectRojoRead =
	| { error: unknown; kind: "failed"; projectPath: string }
	| { kind: "loaded"; project: LoadedRojoProject; rojoDirectory: string }
	| { kind: "missing" };

/**
 * Load the project's settled Rojo project.
 * @param config - Supplies the settled `rojoProject`.
 * @param fileSystem - File system to read.
 * @returns The loaded project, `missing` when there is no file, or the failure.
 */
export function readProjectRojo(config: ResolvedConfig, fileSystem: FileSystem): ProjectRojoRead {
	const projectPath = config.rojoProject;
	if (projectPath === undefined) {
		return { kind: "missing" };
	}

	try {
		const project = tryLoadRojoProject(projectPath, fileSystem);
		if (project === undefined) {
			return { kind: "missing" };
		}

		return { kind: "loaded", project, rojoDirectory: path.dirname(projectPath) };
	} catch (err) {
		return { error: err, kind: "failed", projectPath };
	}
}
