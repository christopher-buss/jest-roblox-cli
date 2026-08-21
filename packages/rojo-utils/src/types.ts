export interface RojoTreeNode {
	$className?: string;
	$ignoreUnknownInstances?: boolean;
	$path?: string | { optional: string };
	$properties?: JSONObject;
	[key: string]: boolean | JSONObject | RojoTreeNode | string | undefined | { optional: string };
}

export interface RojoProject {
	name: string;
	servePort?: number | undefined;
	tree: RojoTreeNode;
}

/**
 * Result of `loadRojoProject` — the validated narrow shape plus the original
 * parsed JSON. Callers that need top-level fields beyond name/servePort/tree
 * (gameId, placeId, globIgnorePaths, etc.) read them from `raw` rather than
 * re-parsing the project file.
 */
export interface LoadedRojoProject extends RojoProject {
	raw: JSONObject;
}

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
