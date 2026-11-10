import type { RojoTreeNode } from "./rojo-types.ts";
import { isRojoTreeNode, unwrapPath } from "./tree-node.ts";

/** Filesystem classification supplied by the host, without disk access here. */
export type PathKind = "directory" | "file" | "missing";

/**
 * Host seam for distinguishing directory mounts from files and missing paths.
 */
export type PathClassifier = (fsPath: string) => PathKind;

/** A `$path` mount whose path is relative to the project file. */
export interface Mount {
	/** Slash-separated instance path below the project root. */
	dataModelPath: string;
	/** Filesystem prefix used before appending the unmatched source suffix. */
	fsPath: string;
}

const TRAILING_SLASH_PATTERN = /\/$/;

/**
 * Every `$path` mount below the root, file or directory, parents before
 * children, with each path as written in the tree.
 * @param node - Subtree to walk.
 * @param currentDataModelPath - Slash-separated instance path of `node`.
 * @returns Mounts in traversal order.
 */
export function listMounts(node: RojoTreeNode, currentDataModelPath = ""): Array<Mount> {
	const result: Array<Mount> = [];
	walk({ currentDataModelPath, node, result });
	return result;
}

/**
 * Collects directory mounts below the root using the supplied classifier.
 * @param options - Subtree, its accumulated instance prefix, and the host classifier.
 * @returns Directory mounts in traversal order, excluding project-file mounts.
 */
export function collectMounts({
	classify,
	currentDataModelPath,
	node,
}: {
	classify: PathClassifier;
	currentDataModelPath: string;
	node: RojoTreeNode;
}): Array<Mount> {
	return listMounts(node, currentDataModelPath).flatMap(({ dataModelPath, fsPath }) => {
		if (fsPath.endsWith(".project.json")) {
			return [];
		}

		const directory = fsPath.replace(TRAILING_SLASH_PATTERN, "");
		return classify(directory) === "directory" ? [{ dataModelPath, fsPath: directory }] : [];
	});
}

/**
 * Retains minimal directory prefixes, preserving sibling boundaries.
 * @param paths - Directory prefixes in desired output order.
 * @returns Prefixes with no containing ancestor in the supplied set.
 */
export function pruneAncestors(paths: Array<string>): Array<string> {
	return paths.filter((candidate) => paths.every((other) => !candidate.startsWith(`${other}/`)));
}

function walk({
	currentDataModelPath,
	node,
	result,
}: {
	currentDataModelPath: string;
	node: RojoTreeNode;
	result: Array<Mount>;
}): void {
	for (const [key, value] of Object.entries(node)) {
		if (key.startsWith("$") || !isRojoTreeNode(value)) {
			continue;
		}

		const dataModelPath = currentDataModelPath === "" ? key : `${currentDataModelPath}/${key}`;
		const fsPath = unwrapPath(value.$path);
		if (fsPath !== undefined) {
			result.push({ dataModelPath, fsPath });
		}

		walk({ currentDataModelPath: dataModelPath, node: value, result });
	}
}
