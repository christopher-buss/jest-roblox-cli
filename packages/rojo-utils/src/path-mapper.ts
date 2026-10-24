import { collectPaths } from "./mount-paths.ts";
import type { RojoTreeNode } from "./rojo-types.ts";
import { findInTree } from "./tree-mapper.ts";

const TRAILING_SLASH = /\/$/;

/**
 * Maps an output root or throws with available mounts for diagnosis.
 * @param outDirectory - Output root expressed relative to the project.
 * @param rojoTree - Resolved project tree with root-relative mounts.
 * @returns The matching instance path; throws when the root has no mapping.
 */
export function mapFsRootToDataModel(outDirectory: string, rojoTree: RojoTreeNode): string {
	const normalized = outDirectory.replace(TRAILING_SLASH, "");
	const result = findInTree({ currentDataModelPath: "", node: rojoTree, targetPath: normalized });
	if (result === undefined) {
		const available: Array<string> = [];
		collectPaths(rojoTree, available);

		let message = `No Rojo tree mapping found for path: ${normalized}`;
		if (available.length > 0) {
			message += `\n\nAvailable $path entries: ${available.join(", ")}`;
		}

		throw new Error(message);
	}

	return result;
}

const LUAU_EXTENSIONS = /\.luau?$/;
const INIT_SUFFIX = /\/init$/;

/**
 * Maps a source path after removing its Lua suffix and init filename.
 * @param fsPath - Source path expressed relative to the project.
 * @param rojoTree - Resolved project tree with root-relative mounts.
 * @returns The mapped instance path, or undefined when no mount contains the file.
 */
export function mapFsPathToDataModel(fsPath: string, rojoTree: RojoTreeNode): string | undefined {
	const normalized = fsPath.replaceAll("\\", "/").replace(LUAU_EXTENSIONS, "");
	const withoutInit = normalized.replace(INIT_SUFFIX, "");

	const rootPath = rojoTree.$path;
	if (typeof rootPath === "string") {
		const normalizedRootPath = rootPath.replace(TRAILING_SLASH, "");
		if (withoutInit === normalizedRootPath) {
			return "";
		}

		if (withoutInit.startsWith(`${normalizedRootPath}/`)) {
			return withoutInit.slice(normalizedRootPath.length + 1);
		}
	}

	return findInTree({ currentDataModelPath: "", node: rojoTree, targetPath: withoutInit });
}
