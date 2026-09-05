import type { RojoTreeNode } from "@isentinel/rojo-utils";
import { collectPaths, resolveMountPath, resolveNestedProjectSources } from "@isentinel/rojo-utils";

import { type } from "arktype";
import type { Stats } from "node:fs";
import * as path from "node:path";
import process from "node:process";

import { rojoProjectSchema } from "../types/rojo.ts";
import { mapWithLimitAsync } from "../utils/concurrency.ts";
import { errorMessage } from "../utils/error-message.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { hashString } from "../utils/hash.ts";
import type { InputDigestCache } from "../utils/input-digest-cache.ts";
import { openInputDigestCache } from "../utils/input-digest-cache.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { isWithinRoot } from "./redirect-path.ts";

export interface RojoInputsOptions {
	/**
	 * Where this walk keeps a digest per file. See `openInputDigestCache` for
	 * what a recorded digest claims and what it gives up.
	 */
	digestCacheFile: string;
	/** Where the inputs are read. Defaults to the real filesystem. */
	fileSystem?: FileSystem | undefined;
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

/**
 * Reads in flight while the input digest runs. High enough to keep the disk
 * busy through the latency of any one read, low enough that a tree of tens of
 * thousands of files cannot exhaust the process file-handle budget.
 */
const HASH_CONCURRENCY = 32;

/** What the input walk carries down the tree, unchanged at every level. */
interface InputWalk {
	files: Set<string>;
	fileSystem: FileSystem;
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
export async function computeRojoInputsHashAsync({
	digestCacheFile,
	fileSystem = nodeFileSystem,
	luauRoots,
	projectJson,
	rojoProjectPath,
	rootDirectory,
}: RojoInputsOptions): Promise<string> {
	// Opened before the walk: a digest is only recorded for a file whose mtime
	// already predates this moment, so the moment has to precede the reads.
	const digests = openInputDigestCache(digestCacheFile, fileSystem);
	const projectDirectory = path.dirname(rojoProjectPath);
	// One read, and the digest is taken from what it returned: parsing one
	// state of the file and hashing another would fingerprint a tree that was
	// never walked.
	const projectText =
		projectJson ?? (await fileSystem.promises.readFile(rojoProjectPath, "utf-8"));
	const project: ProjectDigest = { key: toKey(rojoProjectPath), hash: hashString(projectText) };

	const { projectFiles, tree } = resolveNestedProjectSources(
		parseRawTree(rojoProjectPath, projectText),
		projectDirectory,
		fileSystem,
	);

	const files = new Set<string>([project.key]);
	for (const projectFile of projectFiles) {
		files.add(toKey(projectFile));
	}

	await walkMountedInputsAsync(tree, projectDirectory, {
		files,
		fileSystem,
		luauRootKeys: luauRoots.map((root) => toKey(path.join(rootDirectory, root))),
		visitedDirectories: new Set<string>(),
	});

	const hash = await digestFilesAsync({ digests, files, project, rootDirectory });
	// After the last read and not before: a file that vanishes mid-walk throws
	// above, and the previous record is worth more than a half-written one.
	digests.save();
	return hash;
}

/**
 * {@link computeRojoInputsHashAsync}, degrading to `undefined` instead of
 * throwing.
 *
 * A project too malformed to hash is also too malformed to build, so every
 * caller wants the same answer — warn, then treat the inputs as changed and let
 * the build report the real fault. Shared so both callers say the same thing.
 */
export async function tryComputeRojoInputsHashAsync(
	options: RojoInputsOptions,
): Promise<string | undefined> {
	try {
		return await computeRojoInputsHashAsync(options);
	} catch (err) {
		process.stderr.write(`Warning: could not hash rojo build inputs: ${errorMessage(err)}
`);
		return undefined;
	}
}

function toKey(filePath: string): string {
	return normalizeWindowsPath(filePath);
}

/** Every file the tree's `$path` mounts reach, added to the walk's file set. */
async function walkMountedInputsAsync(
	tree: RojoTreeNode,
	projectDirectory: string,
	walk: InputWalk,
): Promise<void> {
	const mounts: Array<string> = [];
	collectPaths(tree, mounts);
	// Deduped: one `$path` can appear at several places in the tree, and each
	// mention would otherwise be entered — and stat'd — on its own.
	const distinctMounts = new Set(mounts);
	for (const mount of distinctMounts) {
		// Normalized here and nowhere below, so a child path is the parent's
		// plus a name.
		await collectInputFilesAsync(toKey(resolveMountPath(projectDirectory, mount)), walk);
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

/**
 * One sorted line per input — its path relative to `rootDirectory`, then its
 * content hash.
 *
 * The project file is the one input whose hash the caller already holds: it was
 * digested from the text this call read the project as, which need not be the
 * bytes at the path naming it, and need not be on disk at all.
 */
async function digestFilesAsync({
	digests,
	files,
	project,
	rootDirectory,
}: {
	digests: InputDigestCache;
	files: Set<string>;
	project: ProjectDigest;
	rootDirectory: string;
}): Promise<string> {
	const lines: Array<string> = [];
	// Unordered on purpose: the sort below is what makes the digest stable,
	// so the reads are free to settle in whatever order the disk answers in.
	await mapWithLimitAsync([...files], HASH_CONCURRENCY, async (file) => {
		const relativePath = toKey(path.relative(rootDirectory, file));
		const hash = file === project.key ? project.hash : await digests.hashOfAsync(file);
		lines.push(`${relativePath}\0${hash}`);
	});

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
async function collectInputFilesAsync(target: string, walk: InputWalk): Promise<void> {
	let stats: Stats;
	try {
		stats = await walk.fileSystem.promises.stat(target);
	} catch {
		// Mount declared in the rojo tree but absent on disk.
		return;
	}

	if (stats.isDirectory()) {
		await descendAsync({ directory: target, walk });
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
async function descendAsync({
	directory,
	inheritedReal,
	walk,
}: {
	directory: string;
	/** Omitted by a caller entering the walk, which has no parent to ask. */
	inheritedReal?: string | undefined;
	walk: InputWalk;
}): Promise<void> {
	if (coveredByLuauRoot(directory, walk.luauRootKeys)) {
		return;
	}

	// realpath collapses pnpm symlink cycles to a canonical key so a self- or
	// ancestor-referencing link is walked once rather than forever.
	const real = inheritedReal ?? toKey(await walk.fileSystem.promises.realpath(directory));
	if (walk.visitedDirectories.has(real)) {
		return;
	}

	walk.visitedDirectories.add(real);

	const entries = await walk.fileSystem.promises.readdir(directory, { withFileTypes: true });
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
			await descendAsync({ directory: target, inheritedReal: `${real}/${entry.name}`, walk });
			continue;
		}

		if (entry.isSymbolicLink()) {
			// Resolved where it is followed, which is the only place a walk can
			// reach the same directory twice, or forever.
			await collectInputFilesAsync(target, walk);
			continue;
		}

		walk.files.add(target);
	}
}
