/** Rojo metadata and child instances; walkers skip non-object children. */
export interface RojoTreeNode {
	/** Rojo instance class, with DataModel marking a game root. */
	$className?: string;
	/** Rojo metadata preserved while expanding nested projects. */
	$ignoreUnknownInstances?: boolean;
	/** Source location relative to its project file, or an optional mount. */
	$path?:
		| string
		| {
				/** A mount that may be absent from the filesystem. */
				optional: string;
		  };
	/**
	 * Instance metadata preserved without recursively treating it as children.
	 */
	$properties?: JSONObject;
	[key: string]:
		| boolean
		| JSONObject
		| RojoTreeNode
		| string
		| undefined
		| {
				/** A mount that may be absent from the filesystem. */
				optional: string;
		  };
}

/**
 * The validated fields understood by this library; other fields remain on raw.
 */
export interface RojoProject {
	/**
	 * The root instance name used when this project is nested under a
	 * directory.
	 */
	name: string;
	/** Optional Rojo server port retained from the project file. */
	servePort?: number | undefined;
	/** Root instance metadata and child instances. */
	tree: RojoTreeNode;
}

/**
 * Result of `loadRojoProject` — the validated narrow shape plus the original
 * parsed JSON. Callers that need top-level fields beyond name/servePort/tree
 * (gameId, placeId, globIgnorePaths, etc.) read them from `raw` rather than
 * re-parsing the project file.
 */
export interface LoadedRojoProject extends RojoProject {
	/**
	 * Original parsed object, including fields outside the validated
	 * interface.
	 */
	raw: JSONObject;
}
