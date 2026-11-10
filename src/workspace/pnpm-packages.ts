import { parseYAML } from "confbox";
import * as path from "node:path";

import { applyExcludes } from "../discovery/apply-excludes.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { createGlobCache, type GlobCache, globSync } from "../utils/glob.ts";
import type { PackageInfo } from "./package-resolver.ts";
import { readPnpmWorkspaceProjects } from "./pnpm-workspace-state.ts";
import { PNPM_MARKER } from "./workspace-root.ts";

export const PACKAGE_JSON_LEAF = "package.json";

interface PnpmWorkspace {
	packages?: Array<string>;
}

/**
 * Read the `name` field of a `package.json`.
 * @param packageJsonPath - Manifest file to read.
 * @param fileSystem - File system to read through.
 * @returns The name, or `undefined` when the file or a string name is absent.
 * @throws {Error} When the file is not valid JSON.
 */
export function readPackageJsonName(
	packageJsonPath: string,
	fileSystem: FileSystem,
): string | undefined {
	if (!fileSystem.existsSync(packageJsonPath)) {
		return undefined;
	}

	const raw = parsePackageJson(fileSystem, packageJsonPath);
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return undefined;
	}

	const nameValue = raw["name"];
	return typeof nameValue === "string" ? nameValue : undefined;
}

/**
 * Every path that `patterns` select with `leaf` appended, minus `!` excludes.
 * @param options - Patterns, leaf and walk inputs.
 * @param options.cache - Glob cache to reuse, if any.
 * @param options.fileSystem - File system to walk.
 * @param options.leaf - File name appended to each pattern.
 * @param options.patterns - Globs, with `!` for exclusions.
 * @param options.workspaceRoot - Root the globs resolve against.
 * @returns The matched paths.
 */
export function matchUnderPatterns({
	cache,
	fileSystem,
	leaf,
	patterns,
	workspaceRoot,
}: {
	readonly cache?: GlobCache | undefined;
	readonly fileSystem: FileSystem;
	readonly leaf: string;
	readonly patterns: Array<string>;
	readonly workspaceRoot: string;
}): Array<string> {
	const globCache = cache ?? createGlobCache([leaf]);
	// Do not trim entries: pnpm does not trim its `packages:` entries.
	const named = patterns.filter((pattern) => pattern !== "");

	// Negations get the leaf too, as pnpm's `normalizePatterns` does.
	const excludeGlobs = new Set<string>();
	const matches = new Set<string>();
	for (const pattern of named) {
		if (pattern.startsWith("!")) {
			const body = pattern.slice(1);
			if (body !== "") {
				excludeGlobs.add(path.posix.join(body, leaf));
			}

			continue;
		}

		const included = globSync(path.posix.join(pattern, leaf), {
			cache: globCache,
			cwd: workspaceRoot,
			fileSystem,
		});
		for (const match of included) {
			matches.add(match);
		}
	}

	return applyExcludes([...matches], [...excludeGlobs]);
}

/**
 * The packages of a pnpm workspace, from pnpm's snapshot or a repo walk.
 * @param options - Names to answer for and walk inputs.
 * @param options.cache - Glob cache to reuse, if any.
 * @param options.fileSystem - File system to read through.
 * @param options.names - Package names the answer must hold.
 * @param options.workspaceRoot - Workspace root directory.
 * @returns The workspace packages.
 */
export function pnpmPackages({
	cache,
	fileSystem,
	names,
	workspaceRoot,
}: {
	readonly cache?: GlobCache | undefined;
	readonly fileSystem: FileSystem;
	readonly names: Array<string>;
	readonly workspaceRoot: string;
}): Array<PackageInfo> {
	const snapshot = readPnpmWorkspaceProjects(workspaceRoot, fileSystem);
	if (
		snapshot !== undefined &&
		names.every((name) => snapshot.some((candidate) => candidate.name === name))
	) {
		return snapshot;
	}

	return walkPnpmPackages({ cache, fileSystem, workspaceRoot });
}

function parsePackageJson(fileSystem: FileSystem, packageJsonPath: string): JSONValue {
	const contents = fileSystem.readFileSync(packageJsonPath, "utf-8");
	try {
		return JSON.parse(contents);
	} catch (err) {
		throw new Error(`Failed to parse ${packageJsonPath}.`, { cause: err });
	}
}

function assertPnpmWorkspace(fileSystem: FileSystem, workspaceRoot: string): string {
	const yamlPath = path.join(workspaceRoot, PNPM_MARKER);
	if (!fileSystem.existsSync(yamlPath)) {
		throw new Error(
			"Workspace mode requires either a `workspace.packages` glob list in your " +
				"jest config or a pnpm-workspace.yaml at the workspace root. " +
				"Use `workspace.packages` (with `--workspace-root` to run from outside " +
				"a package) for Luau-only, npm, or yarn repos.",
		);
	}

	return yamlPath;
}

function walkPnpmPackages({
	cache,
	fileSystem,
	workspaceRoot,
}: {
	readonly cache?: GlobCache | undefined;
	readonly fileSystem: FileSystem;
	readonly workspaceRoot: string;
}): Array<PackageInfo> {
	const yamlPath = assertPnpmWorkspace(fileSystem, workspaceRoot);
	const yaml = parseYAML<PnpmWorkspace>(fileSystem.readFileSync(yamlPath, "utf-8"));
	const packages: Array<PackageInfo> = [];
	const seenDirectories = new Set<string>();
	// pnpm always includes the root and never excludes it.
	const matches = [PACKAGE_JSON_LEAF];
	if (yaml.packages !== undefined) {
		const walk = { cache, fileSystem, leaf: PACKAGE_JSON_LEAF, workspaceRoot };
		matches.push(...matchUnderPatterns({ ...walk, patterns: yaml.packages }));
	}

	for (const match of matches) {
		const packageJsonPath = path.join(workspaceRoot, match);
		const packageDirectory = path.dirname(packageJsonPath);
		if (seenDirectories.has(packageDirectory)) {
			continue;
		}

		seenDirectories.add(packageDirectory);
		const name = readPackageJsonName(packageJsonPath, fileSystem);
		if (name !== undefined) {
			packages.push({ name, packageDirectory });
		}
	}

	return packages;
}
