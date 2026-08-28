import type { RojoTreeNode } from "@isentinel/rojo-utils";
import { collectPaths, resolveNestedProjectSources } from "@isentinel/rojo-utils";

import { type } from "arktype";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";

import { rojoProjectSchema } from "../types/rojo.ts";
import { errorMessage } from "../utils/error-message.ts";
import { hashFile, hashString } from "../utils/hash.ts";
import { isAbsolutePath, normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { isWithinRoot } from "./redirect-path.ts";

export interface RojoInputsOptions {
	/**
	 * Instrumented roots, excluded because the shadow diff already hashes
	 * them. Relative to `rootDirectory`.
	 */
	luauRoots: Array<string>;
	/**
	 * The project as the caller holds it, for one that is not (yet) the bytes
	 * at `rojoProjectPath`. Parsed and hashed in place of that file, so a
	 * project can be fingerprinted before it is written — or without ever
	 * being written.
	 */
	projectJson?: string | undefined;
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

/** The project file, and the digest of the text this call read it as. */
interface ProjectDigest {
	key: string;
	hash: string;
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
	projectJson,
	rojoProjectPath,
	rootDirectory,
}: RojoInputsOptions): string {
	const projectDirectory = path.dirname(rojoProjectPath);
	// One read, and the digest is taken from what it returned: parsing one
	// state of the file and hashing another would fingerprint a tree that was
	// never walked.
	const projectText = projectJson ?? fs.readFileSync(rojoProjectPath, "utf-8");
	const project: ProjectDigest = { key: toKey(rojoProjectPath), hash: hashString(projectText) };

	const { projectFiles, tree } = resolveNestedProjectSources(
		parseRawTree(rojoProjectPath, projectText),
		projectDirectory,
	);

	const mounts: Array<string> = [];
	collectPaths(tree, mounts);

	const files = new Set<string>([project.key]);
	for (const projectFile of projectFiles) {
		files.add(toKey(projectFile));
	}

	const walk: InputWalk = {
		files,
		luauRootKeys: luauRoots.map((root) => toKey(path.join(rootDirectory, root))),
		visitedDirectories: new Set<string>(),
	};
	// Deduped: one `$path` can appear at several places in the tree, and each
	// mention would otherwise be entered — and stat'd — on its own.
	const distinctMounts = new Set(mounts);
	for (const mount of distinctMounts) {
		// Project-relative unless the project wrote the `$path` absolute, which
		// rojo mounts as written — joining that one onto the project directory
		// would walk a location that does not exist and hash none of its files.
		// Normalized here and nowhere below, so a child path is the parent's
		// plus a name.
		const mountKey = toKey(mount);
		const target = isAbsolutePath(mountKey)
			? mountKey
			: toKey(path.join(projectDirectory, mountKey));
		collectInputFiles(target, walk);
	}

	return digestFiles({ files, project, rootDirectory });
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
 * Reads the project's tree as the build will see it. `loadRojoProject` hands
 * back a nested-resolved tree, which has already erased the inlined project
 * files this hash has to cover, so the text is parsed here instead.
 */
function parseRawTree(rojoProjectPath: string, raw: string): RojoTreeNode {
	const parsed: JSONValue = JSON.parse(raw);
	const result = rojoProjectSchema(parsed);
	if (result instanceof type.errors) {
		throw new Error(`Invalid Rojo project ${rojoProjectPath}: ${result.summary}`);
	}

	return result.tree;
}

function toKey(filePath: string): string {
	return normalizeWindowsPath(filePath);
}

/**
 * One sorted line per input — its path relative to `rootDirectory`, then its
 * content hash.
 *
 * The project file is the one input whose hash the caller already holds: it was
 * digested from the text this call read the project as, which need not be the
 * bytes at the path naming it, and need not be on disk at all.
 */
function digestFiles({
	files,
	project,
	rootDirectory,
}: {
	files: Set<string>;
	project: ProjectDigest;
	rootDirectory: string;
}): string {
	const lines: Array<string> = [];
	for (const file of files) {
		const relativePath = toKey(path.relative(rootDirectory, file));
		const hash = file === project.key ? project.hash : hashFile(file);
		lines.push(`${relativePath}\0${hash}`);
	}

	lines.sort();
	return hashString(lines.join("\n"));
}

function coveredByLuauRoot(directoryKey: string, luauRootKeys: Array<string>): boolean {
	return luauRootKeys.some((root) => isWithinRoot(directoryKey, root));
}

/**
 * Enter a path nothing above has already answered for: a mount, which may not
 * exist on disk at all, or a symlink, which `readdir` reports as a link rather
 * than as whatever it points at.
 */
function collectInputFiles(target: string, walk: InputWalk): void {
	let stats: fs.Stats;
	try {
		stats = fs.statSync(target);
	} catch {
		// Mount declared in the rojo tree but absent on disk.
		return;
	}

	if (stats.isDirectory()) {
		descend({ directory: target, walk });
		return;
	}

	walk.files.add(target);
}

/**
 * Walk a directory, given the canonical location it resolves to — its parent's,
 * plus its own name. A path entered from outside the walk inherits none and
 * resolves its own, but only past the gate below: a root about to be turned
 * away is not worth a `realpath`.
 *
 * A luauRoot is skipped wherever it turns up, not just when it is the mount
 * itself: narrowing puts the roots below their mount, so the walk reaches them
 * on the way down. The shadow diff already content-hashes them, and re-reading
 * a whole instrumented subtree here is the work narrowing exists to avoid.
 * Directories only — a root is one, and a file under a root is reached solely
 * by descending through it.
 */
function descend({
	directory,
	inheritedReal,
	walk,
}: {
	directory: string;
	/** Omitted by a caller entering the walk, which has no parent to ask. */
	inheritedReal?: string | undefined;
	walk: InputWalk;
}): void {
	if (coveredByLuauRoot(directory, walk.luauRootKeys)) {
		return;
	}

	// realpath collapses pnpm symlink cycles to a canonical key so a self- or
	// ancestor-referencing link is walked once rather than forever.
	const real = inheritedReal ?? toKey(fs.realpathSync(directory));
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

		// The kind comes off the `Dirent` and the path off the parent, so a tree
		// of tens of thousands of files costs one syscall per directory rather
		// than one per entry.
		const target = `${directory}/${entry.name}`;
		if (entry.isDirectory()) {
			descend({ directory: target, inheritedReal: `${real}/${entry.name}`, walk });
			continue;
		}

		if (entry.isSymbolicLink()) {
			// Resolved where it is followed, which is the only place a walk can
			// reach the same directory twice, or forever.
			collectInputFiles(target, walk);
			continue;
		}

		walk.files.add(target);
	}
}
