import type { RojoTreeNode } from "./types.ts";
import { isRojoTreeNode, unwrapPath } from "./types.ts";

const TRAILING_SLASH = /\/$/;

export function matchNodePath(
	childNode: RojoTreeNode,
	targetPath: string,
	childDataModelPath: string,
): string | undefined {
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

export function findInTree(
	node: RojoTreeNode,
	targetPath: string,
	currentDataModelPath: string,
): string | undefined {
	for (const [key, value] of Object.entries(node)) {
		if (key.startsWith("$") || !isRojoTreeNode(value)) {
			continue;
		}

		const childNode = value;
		const childDataModelPath =
			currentDataModelPath === "" ? key : `${currentDataModelPath}/${key}`;

		const pathMatch = matchNodePath(childNode, targetPath, childDataModelPath);
		if (pathMatch !== undefined) {
			return pathMatch;
		}

		const found = findInTree(childNode, targetPath, childDataModelPath);
		if (found !== undefined) {
			return found;
		}
	}

	return undefined;
}
