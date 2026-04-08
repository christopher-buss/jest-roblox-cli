import type { RojoProject } from "@isentinel/rojo-utils";

import { type, type Type } from "arktype";

export type { RojoProject, RojoTreeNode } from "@isentinel/rojo-utils";

export const rojoProjectSchema: Type<RojoProject> = type({
	"name": "string",
	"servePort?": "number.integer",
	"tree": "object",
}).as<RojoProject>();
