import { readFileSync } from "node:fs";
import { dirname } from "node:path";

import { resolveNestedProjects } from "./rojo-tree.ts";
import type { RojoProject, RojoTreeNode } from "./types.ts";

export function loadRojoProject(projectPath: string): RojoProject {
	let content: string;
	try {
		content = readFileSync(projectPath, "utf-8");
	} catch (err) {
		throw new Error(`Could not read Rojo project: ${projectPath}`, { cause: err });
	}

	let raw: { name?: unknown; servePort?: unknown; tree?: unknown };
	try {
		raw = JSON.parse(content) as typeof raw;
	} catch (err) {
		throw new Error(`Failed to parse Rojo project: ${projectPath}`, { cause: err });
	}

	if (typeof raw.name !== "string" || raw.name === "") {
		throw new Error(`Rojo project must have a non-empty "name" field: ${projectPath}`);
	}

	if (typeof raw.tree !== "object" || raw.tree === null || Array.isArray(raw.tree)) {
		throw new Error(`Rojo project must have a "tree" object: ${projectPath}`);
	}

	const rootDirectory = dirname(projectPath);
	const tree = resolveNestedProjects(raw.tree as RojoTreeNode, rootDirectory);

	return {
		name: raw.name,
		servePort: typeof raw.servePort === "number" ? raw.servePort : undefined,
		tree,
	};
}
