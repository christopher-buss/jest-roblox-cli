import { type, type Type } from "arktype";

import type { RojoTreeNode } from "./rojo-types.ts";

/**
 * Validates only metadata; walkers narrow child values independently. Rejects
 * arrays as roots.
 */
export const treeSchema: Type<RojoTreeNode> = type({
	"$className?": "string",
	"$ignoreUnknownInstances?": "boolean",
	"$path?": ["string", "|", { optional: "string" }],
	"$properties?": "object",
})
	.narrow((value, context) => {
		return (
			!Array.isArray(value) || context.reject({ actual: "an array", expected: "an object" })
		);
	})
	.as<RojoTreeNode>();
