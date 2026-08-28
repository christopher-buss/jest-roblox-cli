import type { RojoTreeNode } from "@isentinel/rojo-utils";
import { collectPaths, resolveNestedProjectSources } from "@isentinel/rojo-utils";

import { type } from "arktype";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";

import { rojoProjectSchema } from "../types/rojo.ts";
import { errorMessage } from "../utils/error-message.ts";
import { hashFile } from "../utils/hash.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";

export interface RojoInputsOptions {
	/**
	 * Instrumented roots, excluded because the shadow diff already hashes
	 * them.
	 */
	luauRoots: Array<string>;
	rojoProjectPath: string;
	rootDirectory: string;
}

/** What the input walk carries down the tree, unchanged at every level. */
interface InputWalk {
	files: Set<string>;
	/**
	 * Canonical luauRoot paths, whose subtrees the shadow diff already hashes.
	 */
	luauRootKeys: Array<string>;
	visitedDirectories: Set<string>;
}

/**
 * SHA-256 over every rojo build input that lives OUTSIDE the instrumented
 * luauRoots: non-luauRoot `$path` mounts (e.g. `include/RuntimeLib.lua`,
 * vendored `@rbxts`, game assets) plus the rojo project file(s) themselves.
 * The incremental coverage cache folds a mismatch into its rebuild decision so
 * an edit to any of these — which the per-luauRoot shadow diff never observes
 * — still forces a fresh place build instead of silently reusing a stale one.
 *
 * luauRoot files are skipped: the shadow diff already content-hashes them, so
 * re-reading the compiled output here would be wasted work. Throws on a
 * malformed or circular rojo project; the caller degrades to a rebuild.
 */
export function computeRojoInputsHash({
	luauRoots,
	rojoProjectPath,
	rootDirectory,
}: RojoInputsOptions): string {
	const projectDirectory = path.dirname(rojoProjectPath);

	const { projectFiles, tree } = resolveNestedProjectSources(
		readRawTree(rojoProjectPath),
		projectDirectory,
	);

	const mounts: Array<string> = [];
	collectPaths(tree, mounts);

	const luauRootKeys = luauRoots.map((root) => toKey(path.join(rootDirectory, root)));

	const files = new Set<string>([toKey(rojoProjectPath)]);
	for (const projectFile of projectFiles) {
		files.add(toKey(projectFile));
	}

	const visitedDirectories = new Set<string>();
	const walk: InputWalk = { files, luauRootKeys, visitedDirectories };
	for (const mount of mounts) {
		collectInputFiles(path.join(projectDirectory, mount), walk);
	}

	return digestFiles(files, rootDirectory);
}

/**
 * {@link computeRojoInputsHash}, degrading to `undefined` instead of throwing.
 *
 * A project too malformed to hash is also too malformed to build, so every
 * caller wants the same answer — warn, then treat the inputs as changed and let
 * the build report the real fault. Shared so both callers say the same thing.
 */
export function tryComputeRojoInputsHash(options: RojoInputsOptions): string | undefined {
	try {
		return computeRojoInputsHash(options);
	} catch (err) {
		process.stderr.write(`Warning: could not hash rojo build inputs: ${errorMessage(err)}
`);
		return undefined;
	}
}

/**
 * Reads the project's tree as written on disk. `loadRojoProject` hands back a
 * nested-resolved tree, which has already erased the inlined project files this
 * hash has to cover, so the file is parsed here instead.
 */
function readRawTree(rojoProjectPath: string): RojoTreeNode {
	const parsed: JSONValue = JSON.parse(fs.readFileSync(rojoProjectPath, "utf-8"));
	const result = rojoProjectSchema(parsed);
	if (result instanceof type.errors) {
		throw new Error(`Invalid Rojo project ${rojoProjectPath}: ${result.summary}`);
	}

	return result.tree;
}

function toKey(filePath: string): string {
	return normalizeWindowsPath(filePath);
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

function coveredByLuauRoot(mountKey: string, luauRootKeys: Array<string>): boolean {
	return luauRootKeys.some((root) => mountKey === root || mountKey.startsWith(`${root}/`));
}

function collectInputFiles(target: string, walk: InputWalk): void {
	let stats: fs.Stats;
	try {
		stats = fs.statSync(target);
	} catch {
		// Mount declared in the rojo tree but absent on disk.
		return;
	}

	if (!stats.isDirectory()) {
		walk.files.add(toKey(target));
		return;
	}

	// A luauRoot is skipped wherever it turns up, not just when it is the mount
	// itself: narrowing puts the roots below their mount, so the walk reaches
	// them on the way down. The shadow diff already content-hashes them, and
	// re-reading a whole instrumented subtree here is the work narrowing exists
	// to avoid. Directories only — a root is one, and a file under a root is
	// reached solely by descending through it.
	if (!coveredByLuauRoot(toKey(target), walk.luauRootKeys)) {
		walkDirectory(target, walk);
	}
}

function walkDirectory(directory: string, walk: InputWalk): void {
	// realpath collapses pnpm symlink cycles to a canonical key so a self- or
	// ancestor-referencing link is walked once rather than forever.
	const real = toKey(fs.realpathSync(directory));
	if (walk.visitedDirectories.has(real)) {
		return;
	}

	walk.visitedDirectories.add(real);

	const entries = fs.readdirSync(directory, { withFileTypes: true });
	for (const entry of entries) {
		// Skip .git, .jest-roblox, and other dot entries.
		if (entry.name.startsWith(".")) {
			continue;
		}

		collectInputFiles(path.join(directory, entry.name), walk);
	}
}
