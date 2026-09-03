import { isRojoTreeNode } from "@isentinel/rojo-utils";

import * as fs from "node:fs";
import * as path from "node:path";

import type { RojoTreeNode } from "../types/rojo.ts";
import { hashString } from "../utils/hash.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { findStage } from "./stage.ts";

export interface PoolSharedMountsOptions {
	/**
	 * The directory the synthesized project file is written to. The frame the
	 * pool key is derived in, so the same relative mount keys the same on every
	 * machine.
	 */
	projectDirectory: string;
	projectJson: string;
}

/**
 * What {@link poolSharedMounts} would emit, as a number the place-reuse key can
 * hold. Bump it whenever this module would produce different bytes from
 * unchanged sources — a different eligibility rule, a different key, a
 * different pool layout.
 *
 * The key covers this pass's inputs and not the pass, so without a bump a place
 * built by the old rule reads as current and is handed out unchanged.
 */
export const SHARED_POOL_PASS_VERSION = 3;

/** The attribute a marker carries, naming the pooled entry it stands for. */
const SHARED_POOL_ATTRIBUTE = "JestSharedPoolKey";
/**
 * Where the pooled entries live, as a child of the stage. The materializer
 * only looks a stage up by the package name the CLI sends, so a pool sitting
 * beside the packages is never mistaken for one.
 *
 * A package can still claim the name: a Luau-only package takes its name from
 * its directory basename, so a directory called `__shared` stages under
 * exactly this key. Its tree is the run, and the pool is an optimization, so
 * the pass declines rather than overwriting it — see {@link poolSharedMounts}.
 */
const SHARED_POOL_NAME = "__shared";
/**
 * Long enough that a collision — two paths sharing an entry, so one package
 * silently mounts the tree of another — stays out of reach for any project
 * size, short enough to keep the built Instance names readable.
 */
const DIGEST_LENGTH = 16;
/**
 * The extensions a mounted file may carry and still pool: the ones rojo is
 * certain to build an Instance from.
 *
 * An allow list rather than everything rojo reads, and `.json` is out of it
 * because `init.meta.json` wears the same extension while describing an
 * Instance built from elsewhere. The cost of one left out is a mount left out
 * of the pool; the cost of one wrongly in is a failed materialize.
 */
const POOLED_FILE_EXTENSIONS = new Set([".lua", ".luau", ".rbxm", ".rbxmx"]);
/**
 * The metadata a node may declare and still be one a marker can replace.
 * Children are not in it because they are not metadata: they stay on the
 * marker, and the materializer merges them into the clone it resolves.
 */
const MARKER_SAFE_KEYS = new Set(["$className", "$path"]);

/**
 * Build every repeated staged mount once.
 *
 * Rojo has no aliasing between tree nodes, so a `$path` that N packages mount
 * is read N times and written into the place N times. Each path referenced two
 * or more times is hoisted to a single pooled entry under
 * `ServerStorage.__pkg_stage.__shared`, and every occurrence becomes a Folder
 * marker carrying the pool key. The materializer resolves a marker by cloning
 * the pooled entry, so each package still receives a fresh clone and nothing
 * about the run changes but the bytes in the place.
 *
 * Narrow on purpose: only a node that declares nothing beyond the mount itself
 * pools. Its explicit children come with it — they stay on the marker and the
 * materializer merges them into the clone.
 *
 * Declines entirely — no markers, no pool — for a project with no stage, and
 * for one whose stage already holds a package under the pool's own name.
 * Nothing here is worth a build that used to work.
 *
 * A change to what this emits from unchanged sources needs
 * {@link SHARED_POOL_PASS_VERSION} bumped with it; the place-reuse key reads
 * this pass through that number and through nothing else.
 */
export function poolSharedMounts({
	projectDirectory,
	projectJson,
}: PoolSharedMountsOptions): string {
	const project = JSON.parse(projectJson);
	if (!isRojoTreeNode(project)) {
		return projectJson;
	}

	const stage = findStage(project);
	if (stage === undefined || stage[SHARED_POOL_NAME] !== undefined) {
		return projectJson;
	}

	const mounts = new Map<string, Array<RojoTreeNode>>();
	collectPoolCandidates(stage, mounts);

	// Filled in walk order, which one project text always produces the same
	// way, so an unchanged project rebuilds byte-identical bytes and the
	// place-reuse key still matches.
	const pool: RojoTreeNode = { $className: "Folder" };
	let hasPooled = false;
	for (const [mountPath, nodes] of mounts) {
		// A coverage shadow is per package by construction, so it is referenced
		// once and never reaches the filesystem check.
		if (nodes.length < 2 || !buildsAnInstance(mountPath)) {
			continue;
		}

		const key = pathDigest(mountPath, projectDirectory);
		pool[key] = poolEntry(mountPath, nodes);
		for (const node of nodes) {
			markPooled(node, key);
		}

		hasPooled = true;
	}

	if (!hasPooled) {
		return projectJson;
	}

	stage[SHARED_POOL_NAME] = pool;
	return JSON.stringify(project, undefined, 2);
}

/**
 * Whether the node is one a marker can stand in for without losing anything.
 * `$path` moves to the pooled entry, and `$className: "Folder"` goes to both:
 * it is what the marker declares anyway, and the entry is where rojo reads it
 * against the mount. Explicit children survive on the marker. Every other
 * key — `$properties`, `$attributes`, `$ignoreUnknownInstances` — describes
 * the instance rojo builds from the mount, and the clone that replaces it at
 * materialize time carries the pooled entry's own metadata instead.
 */
function isPoolCandidate(node: RojoTreeNode): boolean {
	if (node.$className !== undefined && node.$className !== "Folder") {
		return false;
	}

	return Object.keys(node).every((key) => !key.startsWith("$") || MARKER_SAFE_KEYS.has(key));
}

/** Every staged node the pass could pool, grouped by the path it mounts. */
function collectPoolCandidates(node: RojoTreeNode, mounts: Map<string, Array<RojoTreeNode>>): void {
	const mountPath = node.$path;
	if (typeof mountPath === "string" && isPoolCandidate(node)) {
		const key = normalizeWindowsPath(mountPath);
		const nodes = mounts.get(key);
		if (nodes === undefined) {
			mounts.set(key, [node]);
		} else {
			nodes.push(node);
		}
	}

	for (const [key, value] of Object.entries(node)) {
		if (!key.startsWith("$") && isRojoTreeNode(value)) {
			collectPoolCandidates(value, mounts);
		}
	}
}

/**
 * Whether rojo builds an Instance for the path.
 *
 * The class it builds does not matter — an `init.luau` directory mounts as a
 * ModuleScript, which is what every `@rbxts/*` package is, and the clone the
 * materializer resolves is the entry rather than the marker. Whether anything
 * is built at all does: a marker naming an entry the place does not hold is a
 * failed materialize, where the mount it replaced would merely have been
 * absent. A directory always builds one; a file builds one only if rojo reads
 * its extension.
 */
function buildsAnInstance(mountPath: string): boolean {
	const stats = fs.statSync(mountPath, { throwIfNoEntry: false });
	if (stats === undefined) {
		return false;
	}

	return stats.isDirectory() || POOLED_FILE_EXTENSIONS.has(path.extname(mountPath).toLowerCase());
}

/**
 * Keyed on the path relative to the project directory, so a checkout at a
 * different root — another machine, another clone — keys the same mount the
 * same way and the place-reuse and upload caches keep hitting.
 */
function pathDigest(mountPath: string, projectDirectory: string): string {
	const relative = normalizeWindowsPath(path.relative(projectDirectory, mountPath));
	return hashString(relative).slice(0, DIGEST_LENGTH);
}

/**
 * The one node that mounts the path every node in `nodes` mounted.
 *
 * A class one of them declared rides across rather than being dropped with the
 * mount. Rojo reads a `$className` against what the `$path` builds and refuses
 * the pair unless that is a Folder, so an entry that dropped it would quietly
 * build the ModuleScript an `init.luau` directory makes, under a name the
 * project was rejected for calling a Folder.
 */
function poolEntry(mountPath: string, nodes: Array<RojoTreeNode>): RojoTreeNode {
	if (nodes.some((node) => node.$className !== undefined)) {
		return { $className: "Folder", $path: mountPath };
	}

	return { $path: mountPath };
}

/** Strip the mount off a node and leave the marker the materializer reads. */
function markPooled(node: RojoTreeNode, key: string): void {
	delete node.$path;
	node.$className = "Folder";
	node["$attributes"] = { [SHARED_POOL_ATTRIBUTE]: key };
}
