import type { RojoProject, RojoTreeNode } from "../types/rojo.ts";

export type { RojoProject, RojoTreeNode } from "../types/rojo.ts";

export interface RootEntry {
	luauRoot: string;
	relocatedShadowDirectory?: string;
	shadowDir: string;
}

/** Single-root rewrite options (backward compat). */
export type SingleRootRewriteOptions = BaseRewriteOptions & RootEntry;

/** Multi-root rewrite options. */
export interface MultiRootRewriteOptions extends BaseRewriteOptions {
	roots: Array<RootEntry>;
}

export type RewriteOptions = MultiRootRewriteOptions | SingleRootRewriteOptions;

interface BaseRewriteOptions {
	/** Relative path from the relocated project file back to the original project directory (e.g. ".."). */
	projectRelocation?: string;
}

interface RootContext {
	luauRoot: string;
	relocatedShadowDirectory: string | undefined;
	shadowDirectory: string;
}

interface RewriteContext {
	relocation: string | undefined;
	roots: Array<RootContext>;
}

export function rewriteRojoProject(project: RojoProject, options: RewriteOptions): RojoProject {
	const roots = isMultiRoot(options)
		? options.roots.map(buildRootContext)
		: [buildRootContext(options)];

	const context: RewriteContext = {
		relocation: options.projectRelocation?.replaceAll("\\", "/"),
		roots,
	};

	return {
		...project,
		tree: walkTree(project.tree, context),
	};
}

function isMultiRoot(options: RewriteOptions): options is MultiRootRewriteOptions {
	return "roots" in options;
}

function buildRootContext(entry: RootEntry): RootContext {
	return {
		luauRoot: entry.luauRoot.replaceAll("\\", "/").replace(/\/$/, ""),
		relocatedShadowDirectory: entry.relocatedShadowDirectory?.replaceAll("\\", "/"),
		shadowDirectory: entry.shadowDir,
	};
}

function rewritePath(value: string, context: RewriteContext): string {
	const normalized = value.replaceAll("\\", "/");

	for (const root of context.roots) {
		if (normalized === root.luauRoot || normalized.startsWith(`${root.luauRoot}/`)) {
			const suffix = normalized.slice(root.luauRoot.length);
			if (context.relocation === undefined || root.relocatedShadowDirectory === undefined) {
				return root.shadowDirectory + suffix;
			}

			return root.relocatedShadowDirectory + suffix;
		}
	}

	if (context.relocation !== undefined) {
		return `${context.relocation}/${normalized}`;
	}

	return value;
}

function walkTree(node: RojoTreeNode, context: RewriteContext): RojoTreeNode {
	const result: RojoTreeNode = {};

	for (const [key, value] of Object.entries(node)) {
		if (key === "$path" && typeof value === "string") {
			result[key] = rewritePath(value, context);
		} else if (typeof value === "object" && !Array.isArray(value) && !key.startsWith("$")) {
			result[key] = walkTree(value as RojoTreeNode, context);
		} else {
			result[key] = value;
		}
	}

	return result;
}
