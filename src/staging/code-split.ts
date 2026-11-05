import { isRojoTreeNode } from "@isentinel/rojo-utils";

import type { RojoTreeNode } from "../types/rojo.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import type { MountScan } from "./code-mount.ts";
import { readCodeMount, sortShallowestFirst } from "./code-mount.ts";
import type { BundleInstance, CodeBundleMount } from "./code-split-types.ts";
import { createIgnoreMatcher, readGlobIgnorePaths } from "./glob-ignore.ts";

/** Inputs to {@link splitCodeMounts}. */
export interface SplitCodeMountsOptions {
	/**
	 * The Code Roots: directories holding the code this run compiled. A mount
	 * that resolves inside one is a candidate to travel; every other mount
	 * stays, because a task can rebuild a script and nothing else.
	 */
	codeRoots: ReadonlyArray<PosixRoot>;
	/** Where the mounts are read. Defaults to the real filesystem. */
	fileSystem?: FileSystem;
	/** The directory the synthesized project file is written to. */
	projectDirectory: string;
	/** The synthesized project, serialized. */
	projectJson: string;
}

/** The Harness Place project and the Code Bundle split from it. */
export interface CodeSplit {
	/** The Code Bundle as the task reads it, ready to write. */
	bundleJson: string;
	/** How many source files the bundle carries, for its stage line. */
	fileCount: number;
	/** The Harness Place's project: this one, less what travels. */
	harnessProjectJson: string;
	/**
	 * DataModel paths of the Code Mounts that had to stay, slash-joined for
	 * reading, in the order the project declares them. A finding rather than an
	 * error — the place still serves them, and this is the only thing that says
	 * which speedup was left on the table.
	 */
	stayedMounts: Array<string>;
}

/**
 * What {@link splitCodeMounts} would emit, as a number the place-reuse key can
 * hold. Bump it whenever this module would produce a different Harness Place
 * from unchanged sources — a different candidate rule, a different naming
 * rule, a different pruning rule.
 *
 * The key covers this pass's inputs and not the pass, so without a bump a
 * harness built by the old rule reads as current and is handed out unchanged.
 */
export const CODE_SPLIT_PASS_VERSION = 1;

/** The Code Bundle shape a task rebuilds. Bump on any change to it. */
const CODE_BUNDLE_FORMAT_VERSION = 1;

/** What the tree walk threads through every level. */
interface Split extends MountScan {
	/** Whether the walk rewrote the tree, so the harness is not the input. */
	hasRewritten: boolean;
	mounts: Array<CodeBundleMount>;
	stayedMounts: Array<string>;
}

/**
 * One level of the walk: the node, where in the DataModel it sits, and the
 * split every level contributes to.
 *
 * `depth` counts from the tree root, so 1 is a service — named for rojo rather
 * than for the instance under it, which is why an empty one stays.
 */
interface WalkFrame {
	dataModelPath: ReadonlyArray<string>;
	depth: number;
	node: RojoTreeNode;
	split: Split;
}

/**
 * Split a synthesized rojo project into the Harness Place that stays and the
 * Code Bundle that travels.
 *
 * A mount whose `$path` resolves inside a Code Root and exists on disk is a
 * Code Mount candidate. It travels only when every instance rojo would build
 * from it is a script a task can construct — `.luau`, `.lua`, and
 * non-descriptor `.json` — because an `.rbxm`, a `.meta.json` or a `.toml` has
 * no runtime constructor and a mount that left one behind would go missing
 * from the run. A file rojo builds no instance from rides along instead: it
 * neither travels nor holds the mount back, which is what lets a stock
 * roblox-ts `out/` travel with its `.d.ts` and `.luau.map` files in place.
 * Rojo's own naming rules decide each instance: `init` promotes its directory,
 * `.server`/`.client` pick the script class, every other stem is kept whole so
 * `test.spec.luau` stays `test.spec`.
 *
 * A mount that travels with no explicit children leaves the tree, and an
 * ancestor left with nothing goes with it — except a service, which the
 * project names for rojo rather than for the instance under it. One the
 * project declares children beside keeps its node as a Folder holding them,
 * and the bundle marks it `merge` so the rebuild does not take them out.
 *
 * Pure over the project text and the filesystem: nothing is written here, so
 * the caller decides whether the bundle it gets back is worth writing.
 *
 * A change to what this emits from unchanged sources needs
 * {@link CODE_SPLIT_PASS_VERSION} bumped with it; the place-reuse key reads
 * this pass through that number and through nothing else.
 * @param options - Code Roots, project text and where it is read.
 * @returns The bundle, its file count, the harness project and stayed mounts.
 */
export function splitCodeMounts({
	codeRoots,
	fileSystem = nodeFileSystem,
	projectDirectory,
	projectJson,
}: SplitCodeMountsOptions): CodeSplit {
	const parsed = readProjectTree(projectJson);
	if (parsed === undefined) {
		return splitNothing(projectJson);
	}

	const { project, tree } = parsed;

	const split: Split = {
		codeRoots,
		fileSystem,
		hasRewritten: false,
		ignored: createIgnoreMatcher(readGlobIgnorePaths(project)),
		mounts: [],
		projectDirectory,
		stayedMounts: [],
	};
	visitChildren({ dataModelPath: [], depth: 0, node: tree, split });

	// Shallowest first, which is the one ordering the rebuild needs: a nested
	// mount has to land after the mount it sits under, or the outer one
	// replaces it whole on the way past.
	sortShallowestFirst(split.mounts, (mount) => mount.dataModelPath.length);
	return {
		bundleJson: serializeBundle(split.mounts),
		fileCount: countSources(split.mounts),
		harnessProjectJson: split.hasRewritten
			? JSON.stringify(project, undefined, 2)
			: projectJson,
		stayedMounts: split.stayedMounts,
	};
}

function serializeBundle(mounts: Array<CodeBundleMount>): string {
	return JSON.stringify({ mounts, version: CODE_BUNDLE_FORMAT_VERSION });
}

/**
 * The project and the tree it declares, or `undefined` for a project text this
 * pass cannot walk.
 * @param projectJson - Serialized rojo project.
 * @returns The parsed project and its `tree`, or `undefined`.
 */
function readProjectTree(
	projectJson: string,
): undefined | { project: RojoTreeNode; tree: RojoTreeNode } {
	const project = JSON.parse(projectJson);
	if (!isRojoTreeNode(project)) {
		return undefined;
	}

	const { tree } = project;
	return isRojoTreeNode(tree) ? { project, tree } : undefined;
}

/**
 * The split of a project this pass reads nothing out of — a malformed one, or
 * a tree it cannot walk. The harness is the project itself, which is what
 * every other staging pass hands back rather than failing the build.
 * @param projectJson - Project text handed back as the harness.
 * @returns A split with an empty bundle.
 */
function splitNothing(projectJson: string): CodeSplit {
	return {
		bundleJson: serializeBundle([]),
		fileCount: 0,
		harnessProjectJson: projectJson,
		stayedMounts: [],
	};
}

/**
 * Whether the instance carries a file's text rather than being a Folder.
 * @param instance - Bundle instance to test.
 * @returns True when `source` is set.
 */
function hasSource({ source }: BundleInstance): boolean {
	return source !== undefined;
}

/**
 * How many files the bundle carries — every instance but the Folders.
 * @param mounts - Mounts in the bundle.
 * @returns Count of roots and entries with a source.
 */
function countSources(mounts: Array<CodeBundleMount>): number {
	let count = 0;
	for (const mount of mounts) {
		if (hasSource(mount.root)) {
			count += 1;
		}

		for (const entry of mount.entries) {
			if (hasSource(entry)) {
				count += 1;
			}
		}
	}

	return count;
}

/**
 * Whether the project declares instances of its own beneath this node.
 * @param node - Tree node to test.
 * @returns True when a non-`$` key holds a tree node.
 */
function hasChildNodes(node: RojoTreeNode): boolean {
	return Object.entries(node).some(([key, value]) => {
		return !key.startsWith("$") && isRojoTreeNode(value);
	});
}

/**
 * Whether the node describes nothing once its children are gone: no mount, no
 * class of its own, and nothing under it. Rojo would build an empty Folder for
 * it, which is a folder the run never had.
 * @param node - Tree node to test.
 * @returns True when the node has no `$path`, `$className` or child nodes.
 */
function isEmptyNode(node: RojoTreeNode): boolean {
	return node.$path === undefined && node.$className === undefined && !hasChildNodes(node);
}

/**
 * Whether the node leaves the harness tree along with what it mounted.
 * @param frame - The node, its DataModel path and depth, and the split.
 * @returns True when the caller must delete the node.
 */
function visitNode(frame: WalkFrame): boolean {
	const { dataModelPath, depth, node, split } = frame;
	const read = readCodeMount(node.$path, split);
	if (read === "stays") {
		// Joined here and nowhere else: this one is read by a person off
		// stderr, not walked by the rebuild.
		split.stayedMounts.push(dataModelPath.join("/"));
	}

	const contents = read === "stays" ? undefined : read;
	// Children first, so `merge` and the emptiness test below both read the
	// tree as the harness will hold it rather than as the project wrote it: a
	// child that left is not one the harness has to keep serving.
	visitChildren(frame);
	if (contents === undefined) {
		// A service is named for rojo rather than for the instance under it,
		// and rojo builds it whether or not the project puts anything there.
		return depth > 1 && isEmptyNode(node);
	}

	const isMerging = hasChildNodes(node);
	split.mounts.push({ ...contents, dataModelPath: [...dataModelPath], merge: isMerging });
	split.hasRewritten = true;
	if (!isMerging) {
		return true;
	}

	delete node.$path;
	node.$className = "Folder";
	return false;
}

function visitChildren({ dataModelPath, depth, node, split }: WalkFrame): void {
	for (const [key, value] of Object.entries(node)) {
		if (key.startsWith("$") || !isRojoTreeNode(value)) {
			continue;
		}

		const child: WalkFrame = {
			dataModelPath: [...dataModelPath, key],
			depth: depth + 1,
			node: value,
			split,
		};
		if (visitNode(child)) {
			// oxlint-disable-next-line no-dynamic-delete -- the key is a tree node's own instance name
			delete node[key];
			split.hasRewritten = true;
		}
	}
}
