import { scope } from "arktype";
import * as cp from "node:child_process";
import * as fs from "node:fs";

const VERBATIM_PREFIX = /^\/\/\?\//u;

// A scope rather than a bare `type`, because the node refers to itself and
// only an alias can carry that.
const sourcemapNodeSchema = scope({
	sourcemapNode: {
		"name": "string",
		"children?": "sourcemapNode[]",
		"filePaths?": "string[]",
	},
}).export().sourcemapNode;

export type SourcemapNode = typeof sourcemapNodeSchema.infer;

/**
 * What rojo would build, read without building it. `sourcemap` names every
 * Instance the project resolves to, and `--include-non-scripts` is what makes
 * the Folders a duplicate mount shows up as visible.
 * @param projectPath - Rojo project file.
 * @returns Sourcemap root.
 */
export function readSourcemap(projectPath: string): SourcemapNode {
	// `--absolute` because the synthesized project sits in `.jest-roblox` while
	// its `$path`s point back at the packages, and rojo cannot express one
	// relative to the other.
	const output = cp.execFileSync(
		"rojo",
		["sourcemap", projectPath, "--absolute", "--include-non-scripts"],
		{ encoding: "utf-8", windowsHide: true },
	);
	return sourcemapNodeSchema.assert(JSON.parse(output));
}

/**
 * Every Instance in the tree carrying `name`, however deep.
 * @param node - Tree root.
 * @param name - Instance name.
 * @returns Matching nodes.
 */
export function namedNodes(node: SourcemapNode, name: string): Array<SourcemapNode> {
	return collectNodes(node, (candidate) => candidate.name === name);
}

/**
 * Every Instance rojo would build from a path on disk. Counting these is what
 * says a mount was built once: a marker names the pooled entry rather than the
 * path, so it reads as an Instance with no file behind it.
 * @param node - Tree root.
 * @param filePath - Path on disk.
 * @returns Nodes built from `filePath`.
 */
export function nodesBuiltFrom(node: SourcemapNode, filePath: string): Array<SourcemapNode> {
	const target = samePath(filePath);
	return collectNodes(node, (candidate) => {
		return (candidate.filePaths ?? []).some((each) => samePath(each) === target);
	});
}

export function childNames(node: SourcemapNode): Array<string> {
	const children = node.children ?? [];
	return children.map((child) => child.name);
}

/**
 * The Instance at a path of names below `node`, or `undefined` when the walk
 * runs out. The absolute path compiled test output writes is a walk like this
 * one, so a stage that answers it is a stage whose requires resolve.
 * @param node - Node to start from.
 * @param names - Instance names to walk.
 * @returns The node, or `undefined`.
 */
export function descend(node: SourcemapNode, ...names: Array<string>): SourcemapNode | undefined {
	return names.reduce<SourcemapNode | undefined>(
		(current, name) => (current?.children ?? []).find((child) => child.name === name),
		node,
	);
}

/**
 * Every Instance in the tree the predicate accepts, however deep.
 * @param node - Tree root.
 * @param accepts - Predicate to match.
 * @returns Matching nodes.
 */
function collectNodes(
	node: SourcemapNode,
	accepts: (candidate: SourcemapNode) => boolean,
): Array<SourcemapNode> {
	const found = accepts(node) ? [node] : [];
	const children = node.children ?? [];
	for (const child of children) {
		found.push(...collectNodes(child, accepts));
	}

	return found;
}

/**
 * The spelling two paths share when they name the same file.
 *
 * `rojo sourcemap --absolute` spells a path differently across releases. Up to
 * 7.7.0-rc.1 it wrote `std::path::absolute`, which keeps symlinks and 8.3
 * short names and collapses `..` only on Windows. From 7.7.0 it canonicalizes
 * the project first (rojo-rbx/rojo#1217), which on Windows yields a verbatim
 * `\\?\` path with every short name expanded — while `os.tmpdir()` is often
 * a short name itself. Asking the file system for the real path of both sides
 * reduces every one of those spellings to the same string; every path compared
 * here names a file on disk.
 * @param filePath - Path of a file on disk.
 * @returns Normalized real path.
 */
function samePath(filePath: string): string {
	return fs.realpathSync.native(filePath).replaceAll("\\", "/").replace(VERBATIM_PREFIX, "");
}
