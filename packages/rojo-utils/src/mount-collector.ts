import type { RojoTreeNode } from "./rojo-types.ts";
import { isRojoTreeNode, unwrapPath } from "./tree-node.ts";

/** Filesystem classification supplied by the host, without disk access here. */
export type PathKind = "directory" | "file" | "missing";

/**
 * Host seam for distinguishing directory mounts from files and missing paths.
 */
export type PathClassifier = (fsPath: string) => PathKind;

/** A directory mount whose prefix is relative to the project file. */
export interface Mount {
	/** Slash-separated instance path below the project root. */
	dataModelPath: string;
	/** Filesystem prefix used before appending the unmatched source suffix. */
	fsPath: string;
}

const TRAILING_SLASH_PATTERN = /\/$/;

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
	const result: Array<Mount> = [];
	walk({ classify, currentDataModelPath, node, result });
	return result;
}

/**
 * Retains minimal directory prefixes, preserving sibling boundaries.
 * @param paths - Directory prefixes in desired output order.
 * @returns Prefixes with no containing ancestor in the supplied set.
 */
export function pruneAncestors(paths: Array<string>): Array<string> {
	return paths.filter((candidate) => paths.every((other) => !candidate.startsWith(`${other}/`)));
}

function addDirectoryMount({
	classify,
	dataModelPath,
	node,
	result,
}: {
	classify: PathClassifier;
	dataModelPath: string;
	node: RojoTreeNode;
	result: Array<Mount>;
}): void {
	const rawPath = unwrapPath(node.$path);
	if (rawPath === undefined) {
		return;
	}

	if (rawPath.endsWith(".project.json")) {
		return;
	}

	const fsPath = rawPath.replace(TRAILING_SLASH_PATTERN, "");
	if (classify(fsPath) === "directory") {
		result.push({ dataModelPath, fsPath });
	}
}

function walk({
	classify,
	currentDataModelPath,
	node,
	result,
}: {
	classify: PathClassifier;
	currentDataModelPath: string;
	node: RojoTreeNode;
	result: Array<Mount>;
}): void {
	for (const [key, value] of Object.entries(node)) {
		if (key.startsWith("$") || !isRojoTreeNode(value)) {
			continue;
		}

		const childDataModelPath =
			currentDataModelPath === "" ? key : `${currentDataModelPath}/${key}`;

		addDirectoryMount({ classify, dataModelPath: childDataModelPath, node: value, result });
		walk({ classify, currentDataModelPath: childDataModelPath, node: value, result });
	}
}
