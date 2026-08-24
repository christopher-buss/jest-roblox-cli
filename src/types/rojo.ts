import type { RojoProject } from "@isentinel/rojo-utils";

import { type, type Type } from "arktype";

export type { RojoProject, RojoTreeNode } from "@isentinel/rojo-utils";

export const rojoProjectSchema: Type<RojoProject> = type({
	"name": "string",
	"servePort?": "number.integer",
	// An array sits in arktype's `object` domain, so `[]` would satisfy a bare
	// `object` here and walk as an empty tree.
	"tree": type("object").narrow((tree, ctx) => {
		if (!Array.isArray(tree)) {
			return true;
		}

		return ctx.reject({ actual: "an array", expected: "an object" });
	}),
}).as<RojoProject>();
