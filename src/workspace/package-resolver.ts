import * as path from "node:path";

import type { FileSystem } from "../utils/file-system.ts";
import { createGlobCache, type GlobCache, matchesGlobPattern } from "../utils/glob.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import {
	matchUnderPatterns,
	PACKAGE_JSON_LEAF,
	pnpmPackages,
	readPackageJsonName,
} from "./pnpm-packages.ts";

const JEST_CONFIG_MARKER = /^jest\.config\.[^.]+$/;

const JEST_CONFIG_LEAF = "jest.config.*";

/** A workspace package, named as `--packages` names it. */
export interface PackageInfo {
	/** Name from `package.json#name`. */
	name: string;
	/** Absolute package directory. */
	packageDirectory: string;
}

/** See {@link enumerateWorkspacePackages}. */
export interface EnumerationOptions {
	/** Package directory globs to exclude, relative to the root. */
	exclude?: Array<string> | undefined;
	/** Where the walk reads. */
	fileSystem: FileSystem;
	/** `workspace.packages`; omit to read `pnpm-workspace.yaml` instead. */
	patterns?: Array<string> | undefined;
}

/** How to enumerate workspace packages. */
export interface ResolvePackagesOptions {
	/** Where the walk reads. */
	fileSystem: FileSystem;
	/** `workspace.packages`; omit to read `pnpm-workspace.yaml` instead. */
	patterns?: Array<string> | undefined;
}

interface WorkspaceWalk {
	fileSystem: FileSystem;
	workspaceRoot: string;
}

/**
 * Drop the packages an `exclude` glob names.
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
 * Every package with a `jest.config.*` that no `exclude` glob names.
 * @param workspaceRoot - Workspace root directory.
 * @param options - Exclude globs, glob patterns and file system.
 * @returns The selectable packages.
 * @throws {Error} When two selected packages share a name.
 */
export function enumerateWorkspacePackages(
	workspaceRoot: string,
	{ exclude, fileSystem, patterns }: EnumerationOptions,
): Array<PackageInfo> {
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
	// Check duplicates after the exclude, not before.
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
 * @throws When a name matches no package in the workspace.
 * @param options - Names, workspace root, patterns and file system.
 * @param options.names - Package names to resolve.
 * @param options.workspaceRoot - Workspace root directory.
 * @returns One package per name, in order.
 */
export function resolvePackages({
	fileSystem,
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
 * `cache` must be declared for both leaves, or this walks the root again.
 *
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
