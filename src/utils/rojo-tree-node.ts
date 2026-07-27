import type { RojoTreeNode } from "../types/rojo.ts";

/**
 * Type predicate that narrows a value read out of a Rojo tree to a child
 * `RojoTreeNode`. A node's members are a union — a `$path` mount string, a
 * `$properties` record, a `$ignoreUnknownInstances` boolean, a nested node —
 * so walking `Object.entries` over a tree hands back the whole union, and
 * crossing to the node shape needs a runtime guard rather than an assertion.
 */
export function isRojoTreeNode(value: unknown): value is RojoTreeNode {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
