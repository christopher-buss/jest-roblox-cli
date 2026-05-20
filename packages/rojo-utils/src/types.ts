export interface RojoTreeNode {
	$className?: string;
	$ignoreUnknownInstances?: boolean;
	$path?: string | { optional: string };
	$properties?: Record<string, unknown>;
	[key: string]:
		| boolean
		| Record<string, unknown>
		| RojoTreeNode
		| string
		| undefined
		| { optional: string };
}

export interface RojoProject {
	name: string;
	servePort?: number;
	tree: RojoTreeNode;
}

/**
 * Result of `loadRojoProject` — the validated narrow shape plus the original
 * parsed JSON. Callers that need top-level fields beyond name/servePort/tree
 * (gameId, placeId, globIgnorePaths, etc.) read them from `raw` rather than
 * re-parsing the project file.
 */
export interface LoadedRojoProject extends RojoProject {
	raw: Record<string, unknown>;
}
