import { isRojoTreeNode } from "@isentinel/rojo-utils";
import type { RojoTreeNode } from "@isentinel/rojo-utils";

import { STAGE_KEY } from "../protocol/staged-place.ts";

/**
 * The node every staged package hangs off.
 * @param project - Project whose `tree` is searched.
 * @returns The stage node, or `undefined` when the project has none.
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
