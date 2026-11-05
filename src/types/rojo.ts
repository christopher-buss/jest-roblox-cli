import type { RojoProject, RojoTreeNode } from "@isentinel/rojo-utils";
import { isRojoTreeNode, unwrapPath } from "@isentinel/rojo-utils";

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

/**
 * Every `$path` mount in a rojo tree, parents before children.
 *
 * @param tree - Rojo tree to walk.
 * @param separator - Joins DataModel path segments.
 * @returns `[dataModelPath, mountPath]` pairs.
 */
export function listDataModelMounts(
	tree: RojoTreeNode,
	separator: "." | "/",
): Array<[string, string]> {
	const mounts: Array<[string, string]> = [];
	collectDataModelMounts(tree, { into: mounts, prefix: "", separator });
	return mounts;
}

function collectDataModelMounts(
	node: RojoTreeNode,
	walk: { into: Array<[string, string]>; prefix: string; separator: "." | "/" },
): void {
	for (const [key, value] of Object.entries(node)) {
		if (!isRojoTreeNode(value) || key.startsWith("$")) {
			continue;
		}

		const dataModelPath = walk.prefix ? `${walk.prefix}${walk.separator}${key}` : key;
		const mountPath = unwrapPath(value.$path);
		if (mountPath !== undefined) {
			walk.into.push([dataModelPath, mountPath]);
		}

		collectDataModelMounts(value, { ...walk, prefix: dataModelPath });
	}
}
