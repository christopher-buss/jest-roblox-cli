import type { RojoTreeNode } from "./rojo-types.ts";

/**
 * Narrow an arbitrary tree value to a {@link RojoTreeNode}. Tree walkers reach
 * values through the index signature, whose union is wider than the node type,
 * so they need this rather than an assertion. Arrays and `null` are rejected —
 * neither is a valid child instance, and `typeof null === "object"` would
 * otherwise crash the walk.
 * @param value - The tree value to test.
 * @returns Whether the value is a tree node.
 */
export function isRojoTreeNode(value: unknown): value is RojoTreeNode {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Narrows optional mounts already inside the project tree union.
 * @param value - Candidate from an existing parsed tree.
 * @returns Whether the value has a string-valued optional mount.
 */
export function isOptionalPath(value: RojoTreeNode[string]): value is {
	/** A mount that may be absent from the filesystem. */
	optional: string;
} {
	return isRojoTreeNode(value) && typeof value["optional"] === "string";
}

/**
 * Preserves empty string mounts and returns undefined for non-mount values.
 * @param value - Candidate from an existing parsed tree.
 * @returns The required or optional mount string, including empty strings, or undefined.
 */
export function unwrapPath(value: RojoTreeNode[string]): string | undefined {
	if (typeof value === "string") {
		return value;
	}

	return isOptionalPath(value) ? value.optional : undefined;
}
