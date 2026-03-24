import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { RojoTreeNode } from "../types/rojo.ts";

export function resolveNestedProjects(tree: RojoTreeNode, rootDirectory: string): RojoTreeNode {
	return resolveTree(tree, rootDirectory, new Set<string>());
}

export function collectPaths(node: RojoTreeNode, result: Array<string>): void {
	for (const [key, value] of Object.entries(node)) {
		if (key === "$path" && typeof value === "string") {
			result.push(value.replaceAll("\\", "/"));
		} else if (typeof value === "object" && !Array.isArray(value) && !key.startsWith("$")) {
			collectPaths(value as RojoTreeNode, result);
		}
	}
}

function resolveTree(
	node: RojoTreeNode,
	rootDirectory: string,
	visited: Set<string>,
): RojoTreeNode {
	const resolved: RojoTreeNode = {};

	for (const [key, value] of Object.entries(node)) {
		if (key === "$path" && typeof value === "string" && value.endsWith(".project.json")) {
			const projectPath = join(rootDirectory, value);

			if (visited.has(projectPath)) {
				throw new Error(`Circular project reference: ${value}`);
			}

			const chain = new Set(visited);
			chain.add(projectPath);

			const content = readFileSync(projectPath, "utf-8");
			const project = JSON.parse(content) as { tree: RojoTreeNode };
			const innerTree = resolveTree(project.tree, rootDirectory, chain);

			for (const [innerKey, innerValue] of Object.entries(innerTree)) {
				resolved[innerKey] = innerValue;
			}

			continue;
		}

		if (key.startsWith("$") || typeof value !== "object" || Array.isArray(value)) {
			resolved[key] = value;
			continue;
		}

		resolved[key] = resolveTree(value as RojoTreeNode, rootDirectory, visited);
	}

	return resolved;
}
