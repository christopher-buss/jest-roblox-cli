import { type } from "arktype";
import { dirname, join, relative } from "node:path";

import type { FileSystem } from "./file-system.ts";
import { nodeFileSystem } from "./file-system.ts";
import { isAbsoluteMount, resolveMountPath, resolveNativeMountPath } from "./mount-paths.ts";
import { getTreeSchema } from "./project-schema.ts";
import type { RojoTreeNode } from "./rojo-types.ts";
import { isOptionalPath, isRojoTreeNode } from "./tree-node.ts";

/** Expanded mounts and the project files needed for cache invalidation. */
export interface ResolvedNestedProjectSources {
	/** Every nested project consumed, deduplicated in encounter order. */
	projectFiles: Array<string>;
	/** Root instance metadata and child instances. */
	tree: RojoTreeNode;
}

/**
 * Mutable state threaded through {@link resolveTree} during a single
 * resolution.
 */
interface ResolveContext {
	/** Where nested project files are read from. */
	fileSystem: FileSystem;
	/** Absolute paths of every nested project file inlined so far. */
	sources: Set<string>;
	/** Project files on the current chain, for circular-reference detection. */
	visited: Set<string>;
}

interface OptionalMount {
	optional: string;
}

/**
 * Like {@link resolveNestedProjects}, but also reports the absolute path of
 * every nested project file inlined during resolution. Change-detection
 * callers hash these so an edit to a nested `*.project.json` invalidates the
 * build.
 * @param options - Tree and directory the root project is written against.
 * @param fileSystem - Host for all reads and directory discovery.
 * @returns A copied tree and every project file consumed during expansion.
 */
export function resolveNestedProjectSources(
	{ rootDirectory, tree }: { rootDirectory: string; tree: RojoTreeNode },
	fileSystem: FileSystem = nodeFileSystem,
): ResolvedNestedProjectSources {
	const context: ResolveContext = {
		fileSystem,
		sources: new Set<string>(),
		visited: new Set<string>(),
	};
	const resolved = resolveTree({
		context,
		currentDirectory: rootDirectory,
		node: tree,
		originalRoot: rootDirectory,
	});
	return { projectFiles: [...context.sources], tree: resolved };
}

/**
 * Expands project mounts without mutating the input tree.
 * @param options - Tree and directory the root project is written against.
 * @param fileSystem - Host for all reads and directory discovery.
 * @returns A copied tree with nested project mounts expanded against the root directory.
 */
export function resolveNestedProjects(
	{ rootDirectory, tree }: { rootDirectory: string; tree: RojoTreeNode },
	fileSystem: FileSystem = nodeFileSystem,
): RojoTreeNode {
	return resolveNestedProjectSources({ rootDirectory, tree }, fileSystem).tree;
}

function nestedProjectPath({
	currentDirectory,
	fileSystem,
	value,
}: {
	currentDirectory: string;
	fileSystem: FileSystem;
	value: string;
}): string | undefined {
	// Resolve a `$path` string to the nested project file it should inline, or
	// undefined when the path is a plain source mount. Rojo treats a `$path`
	// pointing at a directory containing `default.project.json` as a nested
	// project (e.g. `$path: ".."` into a package root), so honor that alongside
	// explicit `*.project.json` references.
	// Native separators: this path is reported back in `projectFiles`.
	const mountPath = resolveNativeMountPath(currentDirectory, value);
	if (value.endsWith(".project.json")) {
		return mountPath;
	}

	const directoryDefault = join(mountPath, "default.project.json");
	return fileSystem.existsSync(directoryDefault) ? directoryDefault : undefined;
}

function parseNestedTree(content: string): RojoTreeNode {
	const result = type({ tree: getTreeSchema() })(JSON.parse(content));
	if (result instanceof type.errors) {
		throw new Error(result.summary);
	}

	return result.tree;
}

function inlineNestedProject({
	context,
	currentDirectory,
	originalRoot,
	projectPath,
}: {
	context: ResolveContext;
	currentDirectory: string;
	originalRoot: string;
	projectPath: string;
}): RojoTreeNode {
	const chain = new Set([...context.visited, projectPath]);
	context.sources.add(projectPath);

	let content: string;
	try {
		content = context.fileSystem.readFileSync(projectPath, "utf-8");
	} catch (err) {
		const relativePath = relative(currentDirectory, projectPath);
		throw new Error(`Could not read nested Rojo project: ${relativePath}`, { cause: err });
	}

	let tree: RojoTreeNode;
	try {
		tree = parseNestedTree(content);
	} catch (err) {
		const relativePath = relative(currentDirectory, projectPath);
		throw new Error(`Failed to parse nested Rojo project: ${relativePath}`, { cause: err });
	}

	return resolveTree({
		context: {
			fileSystem: context.fileSystem,
			sources: context.sources,
			visited: chain,
		},
		currentDirectory: dirname(projectPath),
		node: tree,
		originalRoot,
	});
}

function resolveRootRelativePath({
	currentDirectory,
	originalRoot,
	value,
}: {
	currentDirectory: string;
	originalRoot: string;
	value: string;
}): string {
	// An absolute `$path` already names the location Rojo mounts, at any depth of
	// nesting. Rebasing it onto `originalRoot` would name a directory that does
	// not exist, and every caller that walks the mounts would then miss the
	// files under it.
	const mountPath = resolveMountPath(currentDirectory, value);
	if (isAbsoluteMount(value)) {
		return mountPath;
	}

	return relative(originalRoot, mountPath).replaceAll("\\", "/");
}

function resolveOptionalPath({
	currentDirectory,
	originalRoot,
	value,
}: {
	currentDirectory: string;
	originalRoot: string;
	value: OptionalMount;
}): OptionalMount {
	return {
		optional: resolveRootRelativePath({
			currentDirectory,
			originalRoot,
			value: value.optional,
		}),
	};
}

function resolveTree({
	context,
	currentDirectory,
	node,
	originalRoot,
}: {
	context: ResolveContext;
	currentDirectory: string;
	node: RojoTreeNode;
	originalRoot: string;
}): RojoTreeNode {
	const resolved: RojoTreeNode = {};

	for (const [key, value] of Object.entries(node)) {
		if (key === "$path" && typeof value === "string") {
			Object.assign(
				resolved,
				resolveStringMount({
					context,
					currentDirectory,
					originalRoot,
					value,
				}),
			);
			continue;
		}

		if (key === "$path" && isOptionalPath(value)) {
			resolved[key] = resolveOptionalPath({ currentDirectory, originalRoot, value });
		} else if (key.startsWith("$") || !isRojoTreeNode(value)) {
			resolved[key] = value;
		} else {
			resolved[key] = resolveTree({ context, currentDirectory, node: value, originalRoot });
		}
	}

	return resolved;
}

function resolveStringMount({
	context,
	currentDirectory,
	originalRoot,
	value,
}: {
	context: ResolveContext;
	currentDirectory: string;
	originalRoot: string;
	value: string;
}): RojoTreeNode {
	const projectPath = nestedProjectPath({
		currentDirectory,
		fileSystem: context.fileSystem,
		value,
	});
	if (projectPath === undefined) {
		return { $path: resolveRootRelativePath({ currentDirectory, originalRoot, value }) };
	}

	if (context.visited.has(projectPath)) {
		throw new Error(`Circular project reference: ${value}`);
	}

	return inlineNestedProject({ context, currentDirectory, originalRoot, projectPath });
}
