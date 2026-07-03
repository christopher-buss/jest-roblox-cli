import type { RojoTreeNode } from "./types.ts";

export type PathKind = "directory" | "file" | "missing";

export type PathClassifier = (fsPath: string) => PathKind;

export interface Mount {
	dataModelPath: string;
	fsPath: string;
}

const TrailingSlashPattern = /\/$/;

export function collectMounts(
	node: RojoTreeNode,
	currentDataModelPath: string,
	classify: PathClassifier,
): Array<Mount> {
	const result: Array<Mount> = [];
	walk(node, currentDataModelPath, classify, result);
	return result;
}

export function pruneAncestors(paths: Array<string>): Array<string> {
	return paths.filter((candidate) => {
		return paths.every((other) => other === candidate || !candidate.startsWith(`${other}/`));
	});
}

function addDirectoryMount(
	node: RojoTreeNode,
	dataModelPath: string,
	classify: PathClassifier,
	result: Array<Mount>,
): void {
	const rawPath = node.$path;
	if (typeof rawPath !== "string") {
		return;
	}

	if (rawPath.endsWith(".project.json")) {
		return;
	}

	const fsPath = rawPath.replace(TrailingSlashPattern, "");
	if (classify(fsPath) === "directory") {
		result.push({ dataModelPath, fsPath });
	}
}

function isTreeChild(value: unknown): value is RojoTreeNode {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function walk(
	node: RojoTreeNode,
	currentDataModelPath: string,
	classify: PathClassifier,
	result: Array<Mount>,
): void {
	for (const [key, value] of Object.entries(node)) {
		if (key.startsWith("$") || !isTreeChild(value)) {
			continue;
		}

		const childDataModelPath =
			currentDataModelPath === "" ? key : `${currentDataModelPath}/${key}`;

		addDirectoryMount(value, childDataModelPath, classify, result);
		walk(value, childDataModelPath, classify, result);
	}
}
