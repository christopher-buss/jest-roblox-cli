import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import type { RojoTreeNode } from "../types/rojo.ts";

export function resolveNestedProjects(tree: RojoTreeNode, rootDirectory: string): RojoTreeNode {
	return resolveTree(tree, rootDirectory, rootDirectory, new Set<string>());
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

function inlineNestedProject(
	projectPath: string,
	currentDirectory: string,
	originalRoot: string,
	visited: Set<string>,
): RojoTreeNode {
	const chain = new Set(visited);
	chain.add(projectPath);

	let content: string;
	try {
		content = readFileSync(projectPath, "utf-8");
	} catch (err) {
		const relativePath = relative(currentDirectory, projectPath);
		throw new Error(`Could not read nested Rojo project: ${relativePath}`, { cause: err });
	}

	const project = JSON.parse(content) as { tree: RojoTreeNode };
	return resolveTree(project.tree, dirname(projectPath), originalRoot, chain);
}

function resolveRootRelativePath(
	currentDirectory: string,
	value: string,
	originalRoot: string,
): string {
	const absolutePath = join(currentDirectory, value);
	return relative(originalRoot, absolutePath).replaceAll("\\", "/");
}

function resolveTree(
	node: RojoTreeNode,
	currentDirectory: string,
	originalRoot: string,
	visited: Set<string>,
): RojoTreeNode {
	const resolved: RojoTreeNode = {};

	for (const [key, value] of Object.entries(node)) {
		if (key === "$path" && typeof value === "string" && value.endsWith(".project.json")) {
			const projectPath = join(currentDirectory, value);
			if (visited.has(projectPath)) {
				throw new Error(`Circular project reference: ${value}`);
			}

			const innerTree = inlineNestedProject(
				projectPath,
				currentDirectory,
				originalRoot,
				visited,
			);
			for (const [innerKey, innerValue] of Object.entries(innerTree)) {
				resolved[innerKey] = innerValue;
			}

			continue;
		}

		if (key === "$path" && typeof value === "string") {
			resolved[key] = resolveRootRelativePath(currentDirectory, value, originalRoot);
			continue;
		}

		if (key.startsWith("$") || typeof value !== "object" || Array.isArray(value)) {
			resolved[key] = value;
			continue;
		}

		resolved[key] = resolveTree(value as RojoTreeNode, currentDirectory, originalRoot, visited);
	}

	return resolved;
}
