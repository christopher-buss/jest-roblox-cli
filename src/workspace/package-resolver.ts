import * as path from "node:path";

import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { createGlobCache, type GlobCache, matchesGlobPattern } from "../utils/glob.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import type { PackageInfo } from "./package-info-types.ts";
import {
	matchUnderPatterns,
	PACKAGE_JSON_LEAF,
	pnpmPackages,
	readPackageJsonName,
} from "./pnpm-packages.ts";

const JEST_CONFIG_MARKER = /^jest\.config\.[^.]+$/;

const JEST_CONFIG_LEAF = "jest.config.*";

export type { PackageInfo } from "./package-info-types.ts";

/** See {@link enumerateWorkspacePackages}. */
export interface EnumerationOptions {
	/**
	 * Globs, relative to the workspace root, naming package directories
	 * workspace mode must never select on its own.
	 */
	exclude?: Array<string> | undefined;
	/** Where the walk reads. Defaults to the real filesystem. */
	fileSystem?: FileSystem | undefined;
	/** `workspace.packages`; omit to read `pnpm-workspace.yaml` instead. */
	patterns?: Array<string> | undefined;
}

/** How to enumerate workspace packages. */
export interface ResolvePackagesOptions {
	/** Where the walk reads. Defaults to the real filesystem. */
	fileSystem?: FileSystem | undefined;
	/**
	 * `workspace.packages` globs. Their presence is what selects the
	 * jest-config-glob source over the pnpm workspace.
	 */
	patterns?: Array<string> | undefined;
}

/** A checkout to enumerate: what reads it, and where its root is. */
interface WorkspaceWalk {
	fileSystem: FileSystem;
	workspaceRoot: string;
}

/**
 * Drop the packages an `exclude` glob names, matching each glob against the
 * package directory relative to the workspace root.
 *
 * Exported for the `--affected-since` source, which never reaches
 * {@link enumerateWorkspacePackages}: turbo and nx hand back directories
 * directly, and an excluded package that changed is still excluded.
 * @param options - Globs, packages and workspace root.
 * @param options.exclude - Globs that drop a package, if any.
 * @param options.packages - Packages to filter.
 * @param options.workspaceRoot - Root the globs match relative to.
 * @returns The packages no glob names.
 */
export function excludePackages({
	exclude,
	packages,
	workspaceRoot,
}: {
	readonly exclude: Array<string> | undefined;
	readonly packages: Array<PackageInfo>;
	readonly workspaceRoot: string;
}): Array<PackageInfo> {
	if (exclude === undefined || exclude.length === 0) {
		return packages;
	}

	return packages.filter((info) => {
		const relative = normalizeWindowsPath(path.relative(workspaceRoot, info.packageDirectory));
		return exclude.every((pattern) => !matchesGlobPattern(relative, pattern));
	});
}

/**
 * Every package a workspace run can select on its own: it carries a
 * `jest.config.*` and no `exclude` glob names it.
 *
 * Distinct from {@link resolvePackages}, which answers "which packages exist" for
 * a name lookup. A package with no jest config is not a candidate here — a bare
 * `--workspace` would otherwise pick up every library in the repo — but naming
 * it through `--packages` still resolves, so the run fails on the missing
 * config rather than on a package that reads as absent.
 * @param workspaceRoot - Workspace root directory.
 * @param options - Exclude globs, glob patterns and file system.
 * @returns The selectable packages.
 * @throws {Error} When two selected packages share a name.
 */
export function enumerateWorkspacePackages(
	workspaceRoot: string,
	{ exclude, fileSystem = nodeFileSystem, patterns }: EnumerationOptions = {},
): Array<PackageInfo> {
	// Both filters sit here, downstream of the fork, so a source answers
	// only "which packages exist" and never gets a say in which of them a run
	// may select. A source that applied its own gate would make the exclude
	// depend on which one answered — and the package manager's install-time
	// snapshot, a third source, would silently skip both.
	const cache = createGlobCache([PACKAGE_JSON_LEAF, JEST_CONFIG_LEAF]);
	const candidates =
		patterns !== undefined
			? enumerateFromGlobs({
					cache,
					fileSystem,
					patterns,
					workspaceRoot,
				})
			: pnpmPackages({
					cache,
					fileSystem,
					names: [],
					workspaceRoot,
				});
	const testable = withJestConfig({
		cache,
		fileSystem,
		packages: candidates,
		workspaceRoot,
	});
	// After the exclude, not before: an excluded fixture sharing a name with a
	// real package would otherwise fail the run it was excluded from.
	const selected = excludePackages({
		exclude,
		packages: testable,
		workspaceRoot,
	});
	assertNoDuplicateNames(selected, workspaceRoot);
	return selected;
}

/**
 * Resolve `names` to their packages, in the order asked for.
 *
 * Plural because enumeration is the expensive half and the answer is the same
 * for every name: `--packages a,b,c` costs one enumeration, not three.
 *
 * @throws When a name matches no package in the workspace.
 * @param options - Names, workspace root, patterns and file system.
 * @param options.names - Package names to resolve.
 * @param options.workspaceRoot - Workspace root directory.
 * @returns One package per name, in order.
 */
export function resolvePackages({
	fileSystem = nodeFileSystem,
	names,
	patterns,
	workspaceRoot,
}: ResolvePackagesOptions & {
	readonly names: Array<string>;
	readonly workspaceRoot: string;
}): Array<PackageInfo> {
	const packages =
		patterns !== undefined
			? enumerateFromGlobs({ fileSystem, patterns, workspaceRoot })
			: pnpmPackages({ fileSystem, names, workspaceRoot });
	assertNoDuplicateNames(packages, workspaceRoot);
	return names.map((name) => findOrThrow(packages, name));
}

function assertNoDuplicateNames(packages: Array<PackageInfo>, workspaceRoot: string): void {
	const byName = new Map<string, Array<string>>();
	for (const packageInfo of packages) {
		const relative = normalizeWindowsPath(
			path.relative(workspaceRoot, packageInfo.packageDirectory),
		);
		const list = byName.get(packageInfo.name) ?? [];
		// The workspace root relativizes to the empty string, which reads as a
		// missing path in the message.
		list.push(relative === "" ? "." : relative);
		byName.set(packageInfo.name, list);
	}

	for (const [name, paths] of byName) {
		if (paths.length > 1) {
			const sorted = paths.toSorted();
			throw new Error(
				`Duplicate package name "${name}" from ${sorted.join(" and ")}. ` +
					"Add a package.json with a unique `name`, or rename a directory.",
			);
		}
	}
}

function inferPackageName(fileSystem: FileSystem, packageDirectory: string): string {
	const packageJsonPath = path.join(packageDirectory, PACKAGE_JSON_LEAF);
	return readPackageJsonName(packageJsonPath, fileSystem) ?? path.basename(packageDirectory);
}

function collectPackagesFromMatches({
	fileSystem,
	matches,
	packages,
	seenDirectories,
	workspaceRoot,
}: WorkspaceWalk & {
	readonly matches: Array<string>;
	readonly packages: Array<PackageInfo>;
	readonly seenDirectories: Set<string>;
}): void {
	for (const match of matches) {
		if (!JEST_CONFIG_MARKER.test(path.basename(match))) {
			continue;
		}

		const packageDirectory = path.dirname(path.join(workspaceRoot, match));
		if (seenDirectories.has(packageDirectory)) {
			continue;
		}

		seenDirectories.add(packageDirectory);
		packages.push({ name: inferPackageName(fileSystem, packageDirectory), packageDirectory });
	}
}

function enumerateFromGlobs({
	cache,
	fileSystem,
	patterns,
	workspaceRoot,
}: {
	readonly cache?: GlobCache | undefined;
	readonly fileSystem: FileSystem;
	readonly patterns: Array<string>;
	readonly workspaceRoot: string;
}): Array<PackageInfo> {
	const seenDirectories = new Set<string>();
	const packages: Array<PackageInfo> = [];

	collectPackagesFromMatches({
		fileSystem,
		matches: matchUnderPatterns({
			cache,
			fileSystem,
			leaf: JEST_CONFIG_LEAF,
			patterns,
			workspaceRoot,
		}),
		packages,
		seenDirectories,
		workspaceRoot,
	});

	return packages;
}

/**
 * The packages carrying a `jest.config.*`, whichever source found them.
 *
 * A package manager's list answers "what does it install", which in a repo with
 * libraries and fixtures is a much wider set than "what has tests" — a bare
 * `--workspace` would otherwise select every library in the repo.
 *
 * One sweep of the whole root rather than a `readdir` per package, riding the
 * walk that found the manifests: `cache` is declared for both leaves, so the
 * configs cost no filesystem access of their own.
 * @param options - Glob cache, file system, packages and root.
 * @param options.cache - Glob cache declared for both leaves.
 * @param options.fileSystem - File system to walk.
 * @param options.packages - Candidate packages.
 * @param options.workspaceRoot - Workspace root directory.
 * @returns The candidates that hold a `jest.config.*`.
 */
function withJestConfig({
	cache,
	fileSystem,
	packages,
	workspaceRoot,
}: {
	readonly cache: GlobCache;
	readonly fileSystem: FileSystem;
	readonly packages: Array<PackageInfo>;
	readonly workspaceRoot: string;
}): Array<PackageInfo> {
	const configDirectories = new Set(
		matchUnderPatterns({
			cache,
			fileSystem,
			leaf: JEST_CONFIG_LEAF,
			patterns: ["**"],
			workspaceRoot,
		})
			// The glob accepts the dots a `jest.config.spec.ts` carries; the
			// marker is what holds the leaf to a single suffix.
			.filter((match) => JEST_CONFIG_MARKER.test(path.basename(match)))
			.map((match) => path.dirname(path.join(workspaceRoot, match))),
	);
	return packages.filter((info) => configDirectories.has(info.packageDirectory));
}

function findByName(packages: Array<PackageInfo>, name: string): PackageInfo | undefined {
	return packages.find((candidate) => candidate.name === name);
}

function findOrThrow(packages: Array<PackageInfo>, name: string): PackageInfo {
	const match = findByName(packages, name);
	if (match !== undefined) {
		return match;
	}

	const names = packages.map((candidate) => candidate.name).join(", ");
	throw new Error(`Package "${name}" not found in workspace. Available: ${names}`);
}
