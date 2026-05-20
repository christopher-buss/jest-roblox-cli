import { readFileSync } from "node:fs";
import { dirname } from "node:path";

import { resolveNestedProjects } from "./rojo-tree.ts";
import type { LoadedRojoProject, RojoTreeNode } from "./types.ts";

export function loadRojoProject(projectPath: string): LoadedRojoProject {
	let content: string;
	try {
		content = readFileSync(projectPath, "utf-8");
	} catch (err) {
		throw new Error(`Could not read Rojo project: ${projectPath}`, { cause: err });
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (err) {
		throw new Error(`Failed to parse Rojo project: ${projectPath}`, { cause: err });
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Rojo project must be a JSON object: ${projectPath}`);
	}

	const raw = parsed as Record<string, unknown>;

	if (typeof raw["name"] !== "string" || raw["name"] === "") {
		throw new Error(`Rojo project must have a non-empty "name" field: ${projectPath}`);
	}

	if (typeof raw["tree"] !== "object" || raw["tree"] === null || Array.isArray(raw["tree"])) {
		throw new Error(`Rojo project must have a "tree" object: ${projectPath}`);
	}

	const rootDirectory = dirname(projectPath);
	const tree = resolveNestedProjects(raw["tree"] as RojoTreeNode, rootDirectory);

	return {
		name: raw["name"],
		raw,
		servePort: typeof raw["servePort"] === "number" ? raw["servePort"] : undefined,
		tree,
	};
}
