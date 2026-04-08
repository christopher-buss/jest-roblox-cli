import type { RojoTreeNode } from "./types.ts";

export function matchNodePath(
	childNode: RojoTreeNode,
	targetPath: string,
	childDataModelPath: string,
): string | undefined {
	const nodePath = childNode.$path;
	if (typeof nodePath !== "string") {
		return undefined;
	}

	const normalizedNodePath = nodePath.replace(/\/$/, "");
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
		if (key.startsWith("$") || typeof value !== "object") {
			continue;
		}

		const childNode = value as RojoTreeNode;
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
