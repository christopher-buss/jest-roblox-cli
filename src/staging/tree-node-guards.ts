import { isOptionalPath, isRojoTreeNode } from "@isentinel/rojo-utils";

import type { RojoTreeNode } from "../types/rojo.ts";

/**
 * Whether a tree value is a child node rather than an optional-path object.
 * @param value - Value read from a tree node key.
 * @returns True for a child tree node.
 */
export function isTreeNode(value: RojoTreeNode[string]): value is RojoTreeNode {
	return isRojoTreeNode(value) && !isOptionalPath(value);
}

/**
 * Whether a tree value is a non-null, non-array object.
 * @param value - Value read from a `$properties` key.
 * @returns True for a JSON object.
 */
export function isProperties(value: RojoTreeNode[string]): value is JSONObject {
	// `typeof null === "object"`, so guard it explicitly — a null `$properties`
	// from a malformed `.project.json` would otherwise reach
	// `Object.entries(null)` and throw. The static type excludes null (it's a
	// JSON-deserialization boundary), so the lint rule can't see the runtime
	// case the guard exists for.
	// oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime JSON may be null
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
