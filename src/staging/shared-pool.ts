import { isRojoTreeNode } from "@isentinel/rojo-utils";
import type { RojoTreeNode } from "@isentinel/rojo-utils";

import * as path from "node:path";

import { SHARED_POOL_ATTRIBUTE, SHARED_POOL_NAME } from "../protocol/staged-place.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { hashString } from "../utils/hash.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { findStage } from "./stage.ts";

/** Inputs to {@link poolSharedMounts}. */
export interface PoolSharedMountsOptions {
	/** Where the mounts are probed. */
	fileSystem: FileSystem;
	/** The directory the synthesized project file is written to. */
	projectDirectory: string;
	/** The synthesized project, serialized. */
	projectJson: string;
}

/**
 * Pass version in the place-reuse key. Bump when this module emits different
 * bytes from unchanged sources, or stale places are reused.
 */
export const SHARED_POOL_PASS_VERSION = 3;

const DIGEST_LENGTH = 16;
const POOLED_FILE_EXTENSIONS = new Set([".lua", ".luau", ".rbxm", ".rbxmx"]);
const MARKER_SAFE_KEYS = new Set(["$className", "$path"]);

/**
 * Build every repeated staged mount once, behind markers the materializer
 * resolves. Output changes need {@link SHARED_POOL_PASS_VERSION} bumped.
 * @param options - Project text, its directory and where mounts are probed.
 * @returns The rewritten project text, or the input when nothing pools.
 */
export function poolSharedMounts({
	fileSystem,
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

	// Order must be deterministic, or the place-reuse key misses.
	const pool: RojoTreeNode = { $className: "Folder" };
	let hasPooled = false;
	for (const [mountPath, nodes] of mounts) {
		if (nodes.length < 2 || !buildsAnInstance(fileSystem, mountPath)) {
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

function isPoolCandidate(node: RojoTreeNode): boolean {
	if (node.$className !== undefined && node.$className !== "Folder") {
		return false;
	}

	return Object.keys(node).every((key) => !key.startsWith("$") || MARKER_SAFE_KEYS.has(key));
}

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

function buildsAnInstance(fileSystem: FileSystem, mountPath: string): boolean {
	const stats = fileSystem.statSync(mountPath, { throwIfNoEntry: false });
	if (stats === undefined) {
		return false;
	}

	return stats.isDirectory() || POOLED_FILE_EXTENSIONS.has(path.extname(mountPath).toLowerCase());
}

/**
 * Relative, so the place-reuse and upload caches hit across checkouts.
 *
 * @param mountPath - Path the nodes mount.
 * @param projectDirectory - Directory the key is relative to.
 * @returns The first `DIGEST_LENGTH` hex digits of the relative path's hash.
 */
function pathDigest(mountPath: string, projectDirectory: string): string {
	const relative = normalizeWindowsPath(path.relative(projectDirectory, mountPath));
	return hashString(relative).slice(0, DIGEST_LENGTH);
}

function poolEntry(mountPath: string, nodes: Array<RojoTreeNode>): RojoTreeNode {
	if (nodes.some((node) => node.$className !== undefined)) {
		return { $className: "Folder", $path: mountPath };
	}

	return { $path: mountPath };
}

function markPooled(node: RojoTreeNode, key: string): void {
	delete node.$path;
	node.$className = "Folder";
	node["$attributes"] = { [SHARED_POOL_ATTRIBUTE]: key };
}
