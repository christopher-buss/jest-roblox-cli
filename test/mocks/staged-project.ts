import { isRojoTreeNode } from "@isentinel/rojo-utils";
import type { RojoTreeNode } from "@isentinel/rojo-utils";

import { type } from "arktype";
import { assert } from "vitest";

import { SHARED_POOL_ATTRIBUTE, STAGE_KEY } from "#src/protocol/staged-place.ts";
import type { MemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";

export const stagedProjectSchema = type({ "[string]": "unknown", "tree": "object" });

export function seed(files: Record<string, string> = {}): MemoryFileSystem {
	return createMemoryFileSystem(files);
}

export function stagedProject(stage: RojoTreeNode, globIgnorePaths?: Array<string>): string {
	return JSON.stringify({
		...(globIgnorePaths === undefined ? {} : { globIgnorePaths }),
		name: "jest-roblox-workspace",
		tree: {
			$className: "DataModel",
			ServerStorage: { $className: "ServerStorage", [STAGE_KEY]: stage },
		},
	});
}

export function staged(
	{ tree }: typeof stagedProjectSchema.infer,
	...keys: Array<string>
): RojoTreeNode | undefined {
	assert(isRojoTreeNode(tree), "expected the project tree to be a node");
	return ["ServerStorage", STAGE_KEY, ...keys].reduce<RojoTreeNode | undefined>(
		(current, key) => (current === undefined ? undefined : child(current, key)),
		tree,
	);
}

export function mountOf(
	project: typeof stagedProjectSchema.infer,
	...keys: Array<string>
): string | undefined {
	const value = staged(project, ...keys)?.$path;
	return typeof value === "string" ? value : undefined;
}

export function poolKeyOf(node: RojoTreeNode | undefined): string | undefined {
	const attributes = node?.["$attributes"];
	if (attributes === undefined) {
		return undefined;
	}

	assert(isRojoTreeNode(attributes), "expected $attributes to be a node");

	const value = attributes[SHARED_POOL_ATTRIBUTE];
	return typeof value === "string" ? value : undefined;
}

function child(node: RojoTreeNode, key: string): RojoTreeNode | undefined {
	const value = node[key];
	if (value === undefined) {
		return undefined;
	}

	assert(isRojoTreeNode(value), `expected a tree node at "${key}"`);
	return value;
}
