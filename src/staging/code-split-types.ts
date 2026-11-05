/* eslint-disable unicorn/no-keyword-prefix -- `className` is the Code Bundle's own key, which the Luau rebuild reads by name. */

/** Every class the rebuild can construct, and so every class that travels. */
export type BundleInstanceClass = "Folder" | "LocalScript" | "ModuleScript" | "Script";

/** One instance the rebuild constructs. */
export interface BundleInstance {
	/** Class the rebuild constructs. */
	className: BundleInstanceClass;
	/** Absent for a Folder, which carries no source. */
	source?: string;
}

/** One instance below a mount root. */
export interface CodeBundleEntry extends BundleInstance {
	/** Slash-joined under the mount root, e.g. `example/test.spec`. */
	path: string;
}

/** One mount the bundle rebuilds in the harness. */
export interface CodeBundleMount {
	/**
	 * One segment per instance down from the DataModel, the first a service
	 * name. Segments rather than a joined string because an instance name may
	 * hold the separator: a workspace stage node is named after its package,
	 * and a scoped one is `@scope/pkg`.
	 */
	dataModelPath: Array<string>;
	/** Instances below the mount root. */
	entries: Array<CodeBundleEntry>;
	/**
	 * Rebuild over what the harness holds there rather than in place of it.
	 * Set for a mount the project declares children beside: those children
	 * stayed, so replacing the instance whole would take them with it.
	 */
	merge: boolean;
	/** The instance at the mount path itself. */
	root: BundleInstance;
}

/** One mount's contents, before the tree says whether it merges. */
export type MountContents = Pick<CodeBundleMount, "entries" | "root">;
