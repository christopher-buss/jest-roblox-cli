import type { RojoTreeNode } from "./rojo-types.ts";
import { isRojoTreeNode, unwrapPath } from "./tree-node.ts";

const TRAILING_SLASH = /\/$/;

/**
 * Matches an exact mount or a descendant bounded by a slash.
 * @param options - Child node, its instance prefix, and the normalized source prefix to match.
 * @returns The child instance path and unmatched suffix, or undefined on a mount miss.
 */
export function matchNodePath({
	childDataModelPath,
	childNode,
	targetPath,
}: {
	childDataModelPath: string;
	childNode: RojoTreeNode;
	targetPath: string;
}): string | undefined {
	const nodePath = unwrapPath(childNode.$path);
	if (nodePath === undefined) {
		return undefined;
	}

	const normalizedNodePath = nodePath.replace(TRAILING_SLASH, "");
	if (normalizedNodePath === targetPath) {
		return childDataModelPath;
	}

	if (targetPath.startsWith(`${normalizedNodePath}/`)) {
		const remainder = targetPath.slice(normalizedNodePath.length + 1);
		return `${childDataModelPath}/${remainder}`;
	}

	return undefined;
}

/**
 * Returns the first matching child mount in depth-first encounter order.
 * @param options - Subtree, its accumulated instance prefix, and the normalized source prefix to match.
 * @returns The first matching instance path, or undefined when every child misses.
 */
export function findInTree({
	currentDataModelPath,
	node,
	targetPath,
}: {
	currentDataModelPath: string;
	node: RojoTreeNode;
	targetPath: string;
}): string | undefined {
	for (const [key, value] of Object.entries(node)) {
		if (key.startsWith("$") || !isRojoTreeNode(value)) {
			continue;
		}

		const childNode = value;
		const childDataModelPath =
			currentDataModelPath === "" ? key : `${currentDataModelPath}/${key}`;

		const pathMatch = matchNodePath({ childDataModelPath, childNode, targetPath });
		if (pathMatch !== undefined) {
			return pathMatch;
		}

		const found = findInTree({
			currentDataModelPath: childDataModelPath,
			node: childNode,
			targetPath,
		});
		if (found !== undefined) {
			return found;
		}
	}

	return undefined;
}
