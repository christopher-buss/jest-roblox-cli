import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import type { RojoTreeNode } from "./types.ts";

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

export function rebaseTreePaths(
	node: RojoTreeNode,
	fromDirectory: string,
	toDirectory: string,
): RojoTreeNode {
	const result: RojoTreeNode = {};

	for (const [key, value] of Object.entries(node)) {
		if (key === "$path" && typeof value === "string") {
			const absolutePath = resolve(fromDirectory, value);
			result[key] = relative(toDirectory, absolutePath).replaceAll("\\", "/");
			continue;
		}

		if (key.startsWith("$") || typeof value !== "object" || Array.isArray(value)) {
			result[key] = value;
			continue;
		}

		result[key] = rebaseTreePaths(value as RojoTreeNode, fromDirectory, toDirectory);
	}

	return result;
}

function nestedProjectPath(currentDirectory: string, value: string): string | undefined {
	// Resolve a `$path` string to the nested project file it should inline, or
	// undefined when the path is a plain source mount. Rojo treats a `$path`
	// pointing at a directory containing `default.project.json` as a nested
	// project (e.g. `$path: ".."` into a package root), so honor that alongside
	// explicit `*.project.json` references.
	if (value.endsWith(".project.json")) {
		return join(currentDirectory, value);
	}

	const directoryDefault = join(currentDirectory, value, "default.project.json");
	return existsSync(directoryDefault) ? directoryDefault : undefined;
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

	let project: { tree: RojoTreeNode };
	try {
		project = JSON.parse(content) as { tree: RojoTreeNode };
	} catch (err) {
		const relativePath = relative(currentDirectory, projectPath);
		throw new Error(`Failed to parse nested Rojo project: ${relativePath}`, { cause: err });
	}

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
		if (key === "$path" && typeof value === "string") {
			const projectPath = nestedProjectPath(currentDirectory, value);
			if (projectPath === undefined) {
				resolved[key] = resolveRootRelativePath(currentDirectory, value, originalRoot);
				continue;
			}

			if (visited.has(projectPath)) {
				throw new Error(`Circular project reference: ${value}`);
			}

			Object.assign(
				resolved,
				inlineNestedProject(projectPath, currentDirectory, originalRoot, visited),
			);
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
