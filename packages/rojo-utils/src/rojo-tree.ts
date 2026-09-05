import { type } from "arktype";
import { dirname, join, relative } from "node:path";

import type { FileSystem } from "./file-system.ts";
import { nodeFileSystem } from "./file-system.ts";
import type { RojoTreeNode } from "./types.ts";
import { isRojoTreeNode } from "./types.ts";

// Validate only the field the resolver reads; resolveTree handles arbitrary
// tree shapes defensively (same contract as `isValidRojoConfig`).
const nestedProjectSchema = type({ tree: "object" });

const ABSOLUTE_MOUNT = /^(?:[/\\]|[A-Za-z]:[/\\])/;

export interface ResolvedNestedProjectSources {
	projectFiles: Array<string>;
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

/**
 * Like {@link resolveNestedProjects}, but also reports the absolute path of
 * every nested project file inlined during resolution. Change-detection
 * callers hash these so an edit to a nested `*.project.json` invalidates the
 * build.
 */
export function resolveNestedProjectSources(
	tree: RojoTreeNode,
	rootDirectory: string,
	fileSystem: FileSystem = nodeFileSystem,
): ResolvedNestedProjectSources {
	const context: ResolveContext = {
		fileSystem,
		sources: new Set<string>(),
		visited: new Set<string>(),
	};
	const resolved = resolveTree(tree, rootDirectory, rootDirectory, context);
	return { projectFiles: [...context.sources], tree: resolved };
}

export function resolveNestedProjects(
	tree: RojoTreeNode,
	rootDirectory: string,
	fileSystem: FileSystem = nodeFileSystem,
): RojoTreeNode {
	return resolveNestedProjectSources(tree, rootDirectory, fileSystem).tree;
}

/**
 * Every `$path` in the tree, with backslashes normalized.
 *
 * A mount is relative to the project file's directory unless the project wrote
 * it absolute, which is preserved as written.
 */
export function collectPaths(node: RojoTreeNode, result: Array<string>): void {
	for (const [key, value] of Object.entries(node)) {
		if (key === "$path" && typeof value === "string") {
			result.push(value.replaceAll("\\", "/"));
		} else if (!key.startsWith("$") && isRojoTreeNode(value)) {
			collectPaths(value, result);
		}
	}
}

/**
 * The filesystem path a `$path` mount names, given the directory it is written
 * against — a project's own directory, or the root a mount was already rebased
 * onto. A `luauRoot` is written the same way and resolves through here too, so
 * a root and a mount are weighed on one rule.
 *
 * Joined, never resolved. `path.resolve` reads a drive-less absolute path
 * (`/external/out`) as drive-relative on Windows and answers with the base's
 * drive, so one mount names a different directory on each host; it also
 * resolves a relative `baseDirectory` against the process cwd, which is not a
 * frame any mount is written in. An absolute mount is already the location, so
 * it is joined onto nothing.
 *
 * Returns a posix-separated path with no trailing separator, matching what
 * {@link collectPaths} yields. A mount may be written `out/`, and `join` keeps
 * that slash where `resolve` ate it; every containment test downstream builds
 * its own `/` boundary, so a mount carrying one reads as inside nothing and
 * nothing reads as inside it.
 *
 * The drive letter is left as written, so a caller that compares two of these
 * canonicalizes both.
 */
export function resolveMountPath(baseDirectory: string, mount: string): string {
	return dropTrailingSlash(resolveNativeMountPath(baseDirectory, mount).replaceAll("\\", "/"));
}

export function rebaseTreePaths(
	node: RojoTreeNode,
	fromDirectory: string,
	toDirectory: string,
): RojoTreeNode {
	const result: RojoTreeNode = {};

	for (const [key, value] of Object.entries(node)) {
		if (key === "$path" && typeof value === "string") {
			const mountPath = resolveNativeMountPath(fromDirectory, value);
			result[key] = relative(toDirectory, mountPath).replaceAll("\\", "/");
			continue;
		}

		if (key.startsWith("$") || !isRojoTreeNode(value)) {
			result[key] = value;
			continue;
		}

		result[key] = rebaseTreePaths(value, fromDirectory, toDirectory);
	}

	return result;
}

/**
 * Whether a `$path` names a location on its own, rather than one relative to
 * the project file.
 *
 * Not `path.isAbsolute`, which answers for the host it runs on: `D:/out` and
 * `\out` both read as relative on Linux, so the same project file would resolve
 * to two different trees depending on which machine read it. Every root a
 * project can write is here — posix, drive, and the backslash forms Windows
 * uses for a drive-relative root and a UNC share.
 */
function isAbsoluteMount(value: string): boolean {
	return ABSOLUTE_MOUNT.test(value);
}

/** {@link resolveMountPath}, with the separators left as written. */
function resolveNativeMountPath(baseDirectory: string, mount: string): string {
	return isAbsoluteMount(mount) ? mount : join(baseDirectory, mount);
}

/**
 * Drop a trailing separator, unless it is the whole location: `/` is the posix
 * root and `D:/` a drive root, and a mount can name either.
 */
function dropTrailingSlash(mountPath: string): string {
	if (!mountPath.endsWith("/")) {
		return mountPath;
	}

	const stripped = mountPath.slice(0, -1);
	return stripped === "" || stripped.endsWith(":") ? mountPath : stripped;
}

function nestedProjectPath(
	fileSystem: FileSystem,
	currentDirectory: string,
	value: string,
): string | undefined {
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
	const result = nestedProjectSchema(JSON.parse(content));
	if (result instanceof type.errors) {
		throw new Error(result.summary);
	}

	if (!isRojoTreeNode(result.tree)) {
		throw new Error("Expected `tree` to be an object");
	}

	return result.tree;
}

function inlineNestedProject(
	projectPath: string,
	currentDirectory: string,
	originalRoot: string,
	context: ResolveContext,
): RojoTreeNode {
	const chain = new Set(context.visited);
	chain.add(projectPath);
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

	return resolveTree(tree, dirname(projectPath), originalRoot, {
		fileSystem: context.fileSystem,
		sources: context.sources,
		visited: chain,
	});
}

function resolveRootRelativePath(
	currentDirectory: string,
	value: string,
	originalRoot: string,
): string {
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

function resolveTree(
	node: RojoTreeNode,
	currentDirectory: string,
	originalRoot: string,
	context: ResolveContext,
): RojoTreeNode {
	const resolved: RojoTreeNode = {};

	for (const [key, value] of Object.entries(node)) {
		if (key === "$path" && typeof value === "string") {
			const projectPath = nestedProjectPath(context.fileSystem, currentDirectory, value);
			if (projectPath === undefined) {
				resolved[key] = resolveRootRelativePath(currentDirectory, value, originalRoot);
				continue;
			}

			if (context.visited.has(projectPath)) {
				throw new Error(`Circular project reference: ${value}`);
			}

			Object.assign(
				resolved,
				inlineNestedProject(projectPath, currentDirectory, originalRoot, context),
			);
			continue;
		}

		if (key.startsWith("$") || !isRojoTreeNode(value)) {
			resolved[key] = value;
			continue;
		}

		resolved[key] = resolveTree(value, currentDirectory, originalRoot, context);
	}

	return resolved;
}
