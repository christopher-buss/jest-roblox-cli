import { type, type Type } from "arktype";

import type { RojoTreeNode } from "./rojo-types.ts";

let treeSchema: Type<RojoTreeNode> | undefined;

/**
 * Validates only metadata; walkers narrow child values independently.
 * @returns The memoized tree schema, rejecting arrays as roots.
 */
export function getTreeSchema(): Type<RojoTreeNode> {
	treeSchema ??= type({
		"$className?": "string",
		"$ignoreUnknownInstances?": "boolean",
		"$path?": ["string", "|", { optional: "string" }],
		"$properties?": "object",
	})
		.narrow((value, context) => {
			return (
				!Array.isArray(value) ||
				context.reject({ actual: "an array", expected: "an object" })
			);
		})
		.as<RojoTreeNode>();
	return treeSchema;
}
