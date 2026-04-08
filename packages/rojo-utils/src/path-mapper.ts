import { collectPaths } from "./rojo-tree.ts";
import { findInTree } from "./tree-mapper.ts";
import type { RojoTreeNode } from "./types.ts";

export function mapFsRootToDataModel(outDirectory: string, rojoTree: RojoTreeNode): string {
	const normalized = outDirectory.replace(/\/$/, "");
	const result = findInTree(rojoTree, normalized, "");
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

export function mapFsPathToDataModel(fsPath: string, rojoTree: RojoTreeNode): string | undefined {
	const normalized = fsPath.replaceAll("\\", "/").replace(LUAU_EXTENSIONS, "");
	const withoutInit = normalized.replace(INIT_SUFFIX, "");
	return findInTree(rojoTree, withoutInit, "");
}
