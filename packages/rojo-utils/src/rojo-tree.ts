import { type } from "arktype";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

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
): ResolvedNestedProjectSources {
	const context: ResolveContext = { sources: new Set<string>(), visited: new Set<string>() };
	const resolved = resolveTree(tree, rootDirectory, rootDirectory, context);
	return { projectFiles: [...context.sources], tree: resolved };
}

export function resolveNestedProjects(tree: RojoTreeNode, rootDirectory: string): RojoTreeNode {
	return resolveNestedProjectSources(tree, rootDirectory).tree;
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

export function rebaseTreePaths(
	node: RojoTreeNode,
	fromDirectory: string,
	toDirectory: string,
): RojoTreeNode {
	const result: RojoTreeNode = {};

	for (const [key, value] of Object.entries(node)) {
		if (key === "$path" && typeof value === "string") {
			const absolutePath = resolve(fromDirectory, value);
			result[key] = relative(toDirectory, absolutePath).replaceAll("\\", "/");
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

function nestedProjectPath(currentDirectory: string, value: string): string | undefined {
	// Resolve a `$path` string to the nested project file it should inline, or
	// undefined when the path is a plain source mount. Rojo treats a `$path`
	// pointing at a directory containing `default.project.json` as a nested
	// project (e.g. `$path: ".."` into a package root), so honor that alongside
	// explicit `*.project.json` references.
	// join rather than resolve: resolve reads a POSIX-absolute path as
	// drive-relative on Windows and stamps `currentDirectory`'s drive onto it.
	// An absolute `$path` is already the location, so it is joined onto nothing.
	const mountPath = isAbsoluteMount(value) ? value : join(currentDirectory, value);
	if (value.endsWith(".project.json")) {
		return mountPath;
	}

	const directoryDefault = join(mountPath, "default.project.json");
	return existsSync(directoryDefault) ? directoryDefault : undefined;
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
		content = readFileSync(projectPath, "utf-8");
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
	if (isAbsoluteMount(value)) {
		return value.replaceAll("\\", "/");
	}

	const absolutePath = join(currentDirectory, value);
	return relative(originalRoot, absolutePath).replaceAll("\\", "/");
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
			const projectPath = nestedProjectPath(currentDirectory, value);
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
