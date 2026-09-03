import { isRojoTreeNode } from "@isentinel/rojo-utils";

import { type } from "arktype";
import { vol } from "memfs";
import { assert } from "vitest";

import type { RojoTreeNode } from "../../src/types/rojo.ts";

/**
 * Where synthesis parks each package's tree, mirroring `STAGE_KEY` in
 * `src/staging/stage.ts`.
 *
 * Restated rather than imported: a fixture built from the reader under test
 * would agree with a broken reader. Every helper below states the same layout
 * once for all three staging specs.
 */
const STAGE_KEY = "__pkg_stage";

/** A project a staging pass has rewritten and handed back as JSON. */
export const stagedProjectSchema = type({ "[string]": "unknown", "tree": "object" });

/** Resets the memfs volume and seeds it with the files a test needs. */
export function seed(files: Record<string, string> = {}): void {
	vol.reset();
	vol.fromJSON(files);
}

/** A wrapped project whose single stage holds `stage`. */
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

/**
 * Walks from the stage down a chain of node keys, short-circuiting on a miss.
 */
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

/** The `$path` a staged node mounts, or `undefined` when it mounts nothing. */
export function mountOf(
	project: typeof stagedProjectSchema.infer,
	...keys: Array<string>
): string | undefined {
	const value = staged(project, ...keys)?.$path;
	return typeof value === "string" ? value : undefined;
}

/**
 * The attribute a shared-pool marker carries, or `undefined` when the node is
 * no marker.
 */
export function poolKeyOf(node: RojoTreeNode | undefined): string | undefined {
	const attributes = node?.["$attributes"];
	if (attributes === undefined) {
		return undefined;
	}

	assert(isRojoTreeNode(attributes), "expected $attributes to be a node");

	const value = attributes["JestSharedPoolKey"];
	return typeof value === "string" ? value : undefined;
}

/**
 * Reads a foreign tree-node key, validating the child is itself a node.
 *
 * A fixture's project.json keys its nodes by arbitrary instance names, so the
 * value arrives through the index signature's union. `isRojoTreeNode` is the
 * narrowing that union asks for — a schema claiming `RojoTreeNode` while
 * checking nothing below the top level would accept an array and hand the
 * caller a `$path` that was never there.
 */
function child(node: RojoTreeNode, key: string): RojoTreeNode | undefined {
	const value = node[key];
	if (value === undefined) {
		return undefined;
	}

	assert(isRojoTreeNode(value), `expected a tree node at "${key}"`);
	return value;
}
