import { type } from "arktype";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";

import { resolveNestedProjects } from "./rojo-tree.ts";
import type { LoadedRojoProject, RojoTreeNode } from "./types.ts";

let treeSchema: type.Any | undefined;

export function loadRojoProject(projectPath: string): LoadedRojoProject {
	const parsed = readJsonFile(projectPath);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Rojo project must be a JSON object: ${projectPath}`);
	}

	const { name, servePort, tree } = parsed;
	if (typeof name !== "string" || name === "") {
		throw new Error(`Rojo project must have a non-empty "name" field: ${projectPath}`);
	}

	if (Array.isArray(tree) || !isRojoTreeNode(tree)) {
		throw new Error(`Rojo project must have a "tree" object: ${projectPath}`);
	}

	return {
		name,
		raw: parsed,
		servePort: typeof servePort === "number" ? servePort : undefined,
		tree: resolveNestedProjects(tree, dirname(projectPath)),
	};
}

// `JSONValue` narrows honestly down to `JSONObject`, but `RojoTreeNode` is a
// wider structural shape than JSON (it carries `undefined` members), so the
// crossing needs a runtime guard rather than an assertion. Built lazily on
// first use (not at module top level) so consumers can auto-mock this module
// without a hoisting TDZ on the arktype import, mirroring `rojo-resolver.ts`.
function isRojoTreeNode(value: unknown): value is RojoTreeNode {
	treeSchema ??= type("object");
	return !(treeSchema(value) instanceof type.errors);
}

function readJsonFile(projectPath: string): JSONValue {
	let content: string;
	try {
		content = readFileSync(projectPath, "utf-8");
	} catch (err) {
		throw new Error(`Could not read Rojo project: ${projectPath}`, { cause: err });
	}

	try {
		return JSON.parse(content);
	} catch (err) {
		throw new Error(`Failed to parse Rojo project: ${projectPath}`, { cause: err });
	}
}
