import type { RojoTreeNode } from "@isentinel/rojo-utils";
import { collectPaths, loadRojoProject, resolveNestedProjectSources } from "@isentinel/rojo-utils";

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { hashFile } from "../utils/hash.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";

export interface RojoInputsOptions {
	/** Instrumented roots, excluded because the shadow diff already hashes them. */
	luauRoots: Array<string>;
	rojoProjectPath: string;
	rootDirectory: string;
}

/**
 * SHA-256 over every rojo build input that lives OUTSIDE the instrumented
 * luauRoots: non-luauRoot `$path` mounts (e.g. `include/RuntimeLib.lua`, vendored
 * `@rbxts`, game assets) plus the rojo project file(s) themselves. The
 * incremental coverage cache folds a mismatch into its rebuild decision so an
 * edit to any of these — which the per-luauRoot shadow diff never observes —
 * still forces a fresh place build instead of silently reusing a stale one.
 *
 * luauRoot files are skipped: the shadow diff already content-hashes them, so
 * re-reading the compiled output here would be wasted work. Throws on a
 * malformed or circular rojo project; the caller degrades to a rebuild.
 */
export function computeRojoInputsHash(options: RojoInputsOptions): string {
	const { luauRoots, rojoProjectPath, rootDirectory } = options;
	const projectDirectory = path.dirname(rojoProjectPath);

	// loadRojoProject validates the file but its `tree` is already
	// nested-resolved, so resolve the RAW tree here to surface the inlined
	// project files for hashing.
	const rawTree = loadRojoProject(rojoProjectPath).raw["tree"] as RojoTreeNode;
	const { projectFiles, tree } = resolveNestedProjectSources(rawTree, projectDirectory);

	const mounts: Array<string> = [];
	collectPaths(tree, mounts);

	const luauRootKeys = luauRoots.map((root) => toKey(path.join(rootDirectory, root)));

	const files = new Set<string>([toKey(rojoProjectPath)]);
	for (const projectFile of projectFiles) {
		files.add(toKey(projectFile));
	}

	const visitedDirectories = new Set<string>();
	for (const mount of mounts) {
		const mountPath = path.join(projectDirectory, mount);
		if (coveredByLuauRoot(toKey(mountPath), luauRootKeys)) {
			continue;
		}

		collectInputFiles(mountPath, visitedDirectories, files);
	}

	return digestFiles(files, rootDirectory);
}

function toKey(filePath: string): string {
	return normalizeWindowsPath(filePath);
}

function coveredByLuauRoot(mountKey: string, luauRootKeys: Array<string>): boolean {
	return luauRootKeys.some((root) => mountKey === root || mountKey.startsWith(`${root}/`));
}

function digestFiles(files: Set<string>, rootDirectory: string): string {
	const lines: Array<string> = [];
	for (const file of files) {
		const relativePath = toKey(path.relative(rootDirectory, file));
		lines.push(`${relativePath}\0${hashFile(file)}`);
	}

	lines.sort();
	return createHash("sha256").update(lines.join("\n")).digest("hex");
}

function collectInputFiles(
	target: string,
	visitedDirectories: Set<string>,
	files: Set<string>,
): void {
	let stats: fs.Stats;
	try {
		stats = fs.statSync(target);
	} catch {
		// Mount declared in the rojo tree but absent on disk.
		return;
	}

	if (stats.isDirectory()) {
		walkDirectory(target, visitedDirectories, files);
		return;
	}

	files.add(toKey(target));
}

function walkDirectory(
	directory: string,
	visitedDirectories: Set<string>,
	files: Set<string>,
): void {
	// realpath collapses pnpm symlink cycles to a canonical key so a self- or
	// ancestor-referencing link is walked once rather than forever.
	const real = toKey(fs.realpathSync(directory));
	if (visitedDirectories.has(real)) {
		return;
	}

	visitedDirectories.add(real);

	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		// Skip .git, .jest-roblox, and other dot entries.
		if (entry.name.startsWith(".")) {
			continue;
		}

		collectInputFiles(path.join(directory, entry.name), visitedDirectories, files);
	}
}
