import { collectPaths, loadRojoProject, resolveNestedProjects } from "@isentinel/rojo-utils";

import * as path from "node:path";
import process from "node:process";

import type { RojoTreeNode } from "../types/rojo.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import { normalizeWindowsPath, toPosixRoot } from "../utils/normalize-windows-path.ts";
import type { InstrumentUniverse } from "./instrument-universe.ts";
import type { NarrowedMount } from "./narrow-roots.ts";
import { narrowLuauRoots } from "./narrow-roots.ts";
import { isWithinRoot } from "./redirect-path.ts";
import {
	collectRojoMounts,
	containsMatchingFile,
	resolveMountWithin,
	unreachableRootWarning,
} from "./root-reachability.ts";
import { isNonInstrumentedFile } from "./shadow-root.ts";
import type { PackageIgnore, WorkspacePackageDescriptor } from "./workspace-prepare-types.ts";

/** What narrowing one package's roots reads. */
interface NarrowPackageOptions {
	descriptor: WorkspacePackageDescriptor;
	fileSystem: FileSystem;
	ignore: PackageIgnore;
	universe: InstrumentUniverse | undefined;
}

/**
 * Accepted coverage roots, deduplicated.
 *
 * @template T - Root path type.
 */
interface RootCollector<T extends string> {
	readonly has: (relative: string) => boolean;
	readonly offer: (relative: T, absolute: string) => void;
	readonly result: Array<T>;
}

/** What every root-discovery pass over one package reads. */
interface DiscoverRootsOptions {
	descriptor: WorkspacePackageDescriptor;
	fileSystem: FileSystem;
	matchesIgnored: (filePath: string) => boolean;
	/** The package's rojo tree, nested projects already inlined. */
	tree: RojoTreeNode;
}

/** One explicit `luauRoots` entry, weighed against the package's rojo tree. */
interface RootCheck {
	descriptor: WorkspacePackageDescriptor;
	/** Absolute `$path` mounts of the package's rojo project. */
	mounts: Set<string>;
	/** The entry as the user wrote it. */
	rawRoot: string;
}

/**
 * Narrow the package's discovered roots to the directories its coverage
 * universe resolves to, in package-relative terms.
 *
 * The walk itself runs on absolute paths, because that is the frame the
 * universe judges a compiled file in; the answer comes back relative, because
 * that is the frame the shadow tree and the manifest are keyed in.
 * @param options - Package descriptor, file system, ignore matchers and
 * universe.
 * @returns Narrowed mounts with package-relative paths.
 */
export function narrowPackageRoots({
	descriptor,
	fileSystem,
	ignore,
	universe,
}: NarrowPackageOptions): Array<NarrowedMount> {
	function toAbsolute(relative: string): PosixRoot {
		return toPosixRoot(path.join(descriptor.packageDirectory, relative));
	}

	function toRelative(absolute: string): PosixRoot {
		return toPosixRoot(path.relative(descriptor.packageDirectory, absolute));
	}

	const tree = resolvePackageTree(descriptor, fileSystem);
	const narrowed = narrowLuauRoots(
		discoverPackageLuauRoots({
			descriptor,
			fileSystem,
			matchesIgnored: ignore.matcher,
			tree,
		}).map(toAbsolute),
		{
			fileSystem,
			isCopyIgnored: ignore.copyMatcher,
			rojoMounts: collectRojoMounts(tree, path.dirname(descriptor.rojoProjectPath)),
			universe,
		},
	);

	return narrowed.map((entry) => {
		return {
			luauRoot: toRelative(entry.luauRoot),
			roots: entry.roots.map(toRelative),
			spine: entry.spine.map(toRelative),
		};
	});
}

/**
 * The package's rojo tree with its nested `.project.json` mounts inlined. Read
 * once per package: root discovery and the mount set the demote is judged
 * against have to see the same tree, and a nested mount is a mount.
 * @param descriptor - Package whose rojo project is read.
 * @param fileSystem - File system to read the projects through.
 * @returns The inlined rojo tree.
 */
function resolvePackageTree(
	descriptor: WorkspacePackageDescriptor,
	fileSystem: FileSystem,
): RojoTreeNode {
	const project = loadRojoProject(descriptor.rojoProjectPath, fileSystem);
	return resolveNestedProjects(
		{ rootDirectory: path.dirname(descriptor.rojoProjectPath), tree: project.tree },
		fileSystem,
	);
}

function isInstrumentableLuauFile(filename: string): boolean {
	if (!filename.endsWith(".luau") && !filename.endsWith(".lua")) {
		return false;
	}

	// Mirror the pipeline's discovery filter: instrumentation skips spec,
	// test, and snapshot files. A directory containing only those would feed
	// `instrumentRoot` zero files and produce an empty shadow dir, which the
	// synthesizer would then swap a parent `$path` into and the demote pass
	// inside `walkToLeaf` would fail to walk. Defer the suffix set to
	// `discover-files.ts` so this filter cannot drift from the
	// instrumenter's view.
	return !isNonInstrumentedFile(filename);
}

/**
 * Mirrors the roblox-ts compiler: it emits `RuntimeLib.lua` (and `Promise.lua`)
 * into the project's rbxts include dir. Instrumenting vendor code wastes work
 * and forces every `TS.import` through cov probes.
 * @param fileSystem - File system to probe through.
 * @param directoryPath - Directory to test.
 * @returns Whether the directory holds a roblox-ts `RuntimeLib`.
 */
function isRbxtsIncludeRoot(fileSystem: FileSystem, directoryPath: string): boolean {
	return (
		fileSystem.existsSync(path.join(directoryPath, "RuntimeLib.lua")) ||
		fileSystem.existsSync(path.join(directoryPath, "RuntimeLib.luau"))
	);
}

/**
 * Common filter applied to every candidate coverage root regardless of how it
 * was discovered (rojo walk or per-pkg `luauRoots`). Returns `true` when the
 * directory should be instrumented.
 *
 * `isRbxtsIncludeRoot` (two `existsSync`s) precedes the recursive
 * `containsMatchingFile` scan so include dirs short-circuit out before the deep
 * walk.
 * @param options - Absolute and package-relative paths, ignore matcher and file
 * system.
 * @returns Whether the directory should be instrumented.
 */
function isInstrumentableRoot({
	absolutePath,
	fileSystem,
	matchesIgnored,
	relativePath,
}: {
	absolutePath: string;
	fileSystem: FileSystem;
	matchesIgnored: (filePath: string) => boolean;
	relativePath: string;
}): boolean {
	if (matchesIgnored(relativePath)) {
		return false;
	}

	if (!fileSystem.existsSync(absolutePath)) {
		return false;
	}

	if (!fileSystem.statSync(absolutePath).isDirectory()) {
		return false;
	}

	if (isRbxtsIncludeRoot(fileSystem, absolutePath)) {
		return false;
	}

	return containsMatchingFile(fileSystem, {
		directoryPath: absolutePath,
		matches: isInstrumentableLuauFile,
	});
}

/**
 * Deduplicating accumulator of the coverage roots that pass
 * `isInstrumentableRoot`.
 *
 * @template T - Root path type.
 * @param filter - Ignore matcher and file system the roots are checked with.
 * @returns `has` and `offer` over one accepted-root list.
 */
function createRootCollector<T extends string>(
	filter: Pick<DiscoverRootsOptions, "fileSystem" | "matchesIgnored">,
): RootCollector<T> {
	const result: Array<T> = [];
	const seen = new Set<string>();
	return {
		has: (relative) => seen.has(relative),
		offer: (relative, absolute) => {
			if (
				!isInstrumentableRoot({ ...filter, absolutePath: absolute, relativePath: relative })
			) {
				return;
			}

			seen.add(relative);
			result.push(relative);
		},
		result,
	};
}

/**
 * Why this package cannot take `rawRoot` as a coverage root, or `undefined`
 * when it can.
 *
 * A root has to name a directory strictly inside the package: the shadow tree
 * mirrors it under `packageShadowRoot` and the manifest keys the report reads
 * are package-relative. A path elsewhere in the rojo tree belongs to whichever
 * package owns it, and the package directory itself is the package, not a root
 * within it. Past that, the root has to be one the synthesized place will
 * actually load.
 * @param check - The package, its mounts and the entry as written.
 * @returns Warning text, or `undefined` when the root is accepted.
 */
function rejectRoot({ descriptor, mounts, rawRoot }: RootCheck): string | undefined {
	const packageDirectory = normalizeWindowsPath(descriptor.packageDirectory);
	const root = normalizeWindowsPath(path.resolve(descriptor.packageDirectory, rawRoot));
	// Judged on the resolved path, not the spelling: `./` and `src/..` name the
	// package root, `src/../../bar` escapes it, and a directory honestly called
	// `..cache` is none of those. `isWithinRoot` admits the root itself, hence
	// the inequality — the package directory is the package, not a root in it.
	if (root === packageDirectory || !isWithinRoot(root, packageDirectory)) {
		return `Warning: luauRoot "${rawRoot}" in ${descriptor.name} is not a directory inside the package, so it reports no coverage.\n`;
	}

	return unreachableRootWarning({
		base: descriptor.packageDirectory,
		mounts,
		rawRoot,
		subject: descriptor.name,
	});
}

function discoverFromLuauRoots(
	{ descriptor, fileSystem, matchesIgnored, tree }: DiscoverRootsOptions,
	luauRoots: Array<string>,
): Array<PosixRoot> {
	const mounts = collectRojoMounts(tree, path.dirname(descriptor.rojoProjectPath));
	const roots = createRootCollector<PosixRoot>({ fileSystem, matchesIgnored });
	for (const rawRoot of luauRoots) {
		const absolute = path.resolve(descriptor.packageDirectory, rawRoot);
		// Canonical, so two spellings of one directory dedupe to one root and
		// the shadow tree mirrors it at the path the manifest names.
		const relative = toPosixRoot(path.relative(descriptor.packageDirectory, absolute));
		if (roots.has(relative)) {
			continue;
		}

		const warning = rejectRoot({ descriptor, mounts, rawRoot });
		if (warning !== undefined) {
			process.stderr.write(warning);
			continue;
		}

		roots.offer(relative, absolute);
	}

	return roots.result;
}

function collectRojoMountedPaths(tree: RojoTreeNode): Array<string> {
	const collected: Array<string> = [];
	collectPaths(tree, collected);
	return collected;
}

function discoverFromRojoWalk({
	descriptor,
	fileSystem,
	matchesIgnored,
	tree,
}: DiscoverRootsOptions): Array<string> {
	const collected = collectRojoMountedPaths(tree);
	const rojoDirectory = path.dirname(descriptor.rojoProjectPath);
	const roots = createRootCollector<string>({ fileSystem, matchesIgnored });
	for (const rawPath of collected) {
		// The package directory is the frame here; single mode passes its own
		// and the answer is the same shape. See {@link resolveMountWithin}.
		const relative = resolveMountWithin(rawPath, {
			frame: descriptor.packageDirectory,
			rojoDirectory,
		});
		if (relative === undefined || roots.has(relative)) {
			continue;
		}

		roots.offer(relative, path.resolve(descriptor.packageDirectory, relative));
	}

	return roots.result;
}

function discoverPackageLuauRoots(options: DiscoverRootsOptions): Array<string> {
	const { descriptor } = options;
	// Short-circuit when the package opts into explicit luauRoots — mirrors
	// single mode's `> 0` gate in `prepare.ts:selectRawLuauRoots`.
	// Empty array falls through to the rojo walk (auto-detect).
	if (descriptor.luauRoots !== undefined && descriptor.luauRoots.length > 0) {
		return discoverFromLuauRoots(options, descriptor.luauRoots);
	}

	return discoverFromRojoWalk(options);
}
