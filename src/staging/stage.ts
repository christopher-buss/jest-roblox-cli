import { isRojoTreeNode } from "@isentinel/rojo-utils";

import type { RojoTreeNode } from "../types/rojo.ts";

/** Where synthesis parks each package's tree, under `ServerStorage`. */
export const STAGE_KEY = "__pkg_stage";

/**
 * The node every staged package hangs off, or `undefined` for a project that
 * has none.
 *
 * A `wrap: false` project keeps every service where the engine wants it, so
 * every staging pass is a no-op for one, and this is where each of them says
 * so. Malformed shapes report the same way: a pass that cannot find the stage
 * hands its input back rather than failing the build.
 */
export function findStage({ tree }: RojoTreeNode): RojoTreeNode | undefined {
	if (!isRojoTreeNode(tree)) {
		return undefined;
	}

	const serverStorage = tree["ServerStorage"];
	if (!isRojoTreeNode(serverStorage)) {
		return undefined;
	}

	const stage = serverStorage[STAGE_KEY];
	return isRojoTreeNode(stage) ? stage : undefined;
}
