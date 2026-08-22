import { parseYAML } from "confbox";
import * as fs from "node:fs";
import * as path from "node:path";

import { createGlobCache, globSync } from "../utils/glob.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";

const JEST_CONFIG_MARKER = /^jest\.config\.[^.]+$/;

export interface PackageInfo {
	name: string;
	packageDirectory: string;
}

interface PnpmWorkspace {
	packages?: Array<string>;
}

export function readPackageJsonName(packageJsonPath: string): string | undefined {
	if (!fs.existsSync(packageJsonPath)) {
		return undefined;
	}

	const raw = parsePackageJson(packageJsonPath);
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return undefined;
	}

	const nameValue = raw["name"];
	return typeof nameValue === "string" ? nameValue : undefined;
}

/**
 * Enumerate workspace packages. With `patterns` (from `workspace.packages`),
 * resolve directories by globbing for a `jest.config.*` — works in any repo,
 * including Luau-only / npm / yarn workspaces with no `pnpm-workspace.yaml`.
 * Without `patterns`, fall back to reading `pnpm-workspace.yaml`.
 */
export function listPackages(workspaceRoot: string, patterns?: Array<string>): Array<PackageInfo> {
	if (patterns !== undefined) {
		return enumerateFromGlobs(workspaceRoot, patterns);
	}

	return listPnpmPackages(workspaceRoot);
}

export function resolvePackage(
	workspaceRoot: string,
	name: string,
	patterns?: Array<string>,
): PackageInfo {
	const candidates = listPackages(workspaceRoot, patterns);
	for (const candidate of candidates) {
		if (candidate.name === name) {
			return candidate;
		}
	}

	const names = candidates.map((candidate) => candidate.name).join(", ");
	throw new Error(`Package "${name}" not found in workspace. Available: ${names}`);
}

function parsePackageJson(packageJsonPath: string): JSONValue {
	const contents = fs.readFileSync(packageJsonPath, "utf-8");
	try {
		return JSON.parse(contents);
	} catch (err) {
		throw new Error(`Failed to parse ${packageJsonPath}.`, { cause: err });
	}
}

/**
 * Every path under `workspaceRoot` that `patterns` select with `leaf`
 * appended.
 */
function matchUnderPatterns(
	workspaceRoot: string,
	patterns: Array<string>,
	leaf: string,
): Array<string> {
	// One walk of the workspace root serves every pattern.
	const globCache = createGlobCache();
	const matches: Array<string> = [];
	for (const pattern of patterns) {
		// `path.posix.join` reads a blank entry as the root, which would
		// select a package nobody asked for.
		if (pattern.trim() === "") {
			continue;
		}

		matches.push(
			...globSync(path.posix.join(pattern, leaf), { cache: globCache, cwd: workspaceRoot }),
		);
	}

	return matches;
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

function listPnpmPackages(workspaceRoot: string): Array<PackageInfo> {
	const yamlPath = path.join(workspaceRoot, "pnpm-workspace.yaml");
	if (!fs.existsSync(yamlPath)) {
		throw new Error(
			"Workspace mode requires either a `workspace.packages` glob list in your " +
				"jest config or a pnpm-workspace.yaml at the workspace root. " +
				"Use `workspace.packages` (with `--workspace-root` to run from outside " +
				"a package) for Luau-only, npm, or yarn repos.",
		);
	}

	const yaml = parseYAML<PnpmWorkspace>(fs.readFileSync(yamlPath, "utf-8"));
	const patterns = yaml.packages ?? [];

	const packages: Array<PackageInfo> = [];
	const seenDirectories = new Set<string>();
	for (const match of matchUnderPatterns(workspaceRoot, patterns, "package.json")) {
		const packageJsonPath = path.join(workspaceRoot, match);
		const packageDirectory = path.dirname(packageJsonPath);
		// Overlapping patterns — `packages/*` beside `packages/foo` — select
		// the same package twice.
		if (seenDirectories.has(packageDirectory)) {
			continue;
		}

		seenDirectories.add(packageDirectory);
		const name = readPackageJsonName(packageJsonPath);
		if (name !== undefined) {
			packages.push({ name, packageDirectory });
		}
	}

	assertNoDuplicateNames(packages, workspaceRoot);
	return packages;
}

function inferPackageName(packageDirectory: string): string {
	const packageJsonPath = path.join(packageDirectory, "package.json");
	return readPackageJsonName(packageJsonPath) ?? path.basename(packageDirectory);
}

function collectPackagesFromMatches(
	matches: Array<string>,
	workspaceRoot: string,
	seenDirectories: Set<string>,
	packages: Array<PackageInfo>,
): void {
	for (const match of matches) {
		if (!JEST_CONFIG_MARKER.test(path.basename(match))) {
			continue;
		}

		const packageDirectory = path.dirname(path.join(workspaceRoot, match));
		if (seenDirectories.has(packageDirectory)) {
			continue;
		}

		seenDirectories.add(packageDirectory);
		packages.push({ name: inferPackageName(packageDirectory), packageDirectory });
	}
}

function enumerateFromGlobs(workspaceRoot: string, patterns: Array<string>): Array<PackageInfo> {
	const seenDirectories = new Set<string>();
	const packages: Array<PackageInfo> = [];

	collectPackagesFromMatches(
		matchUnderPatterns(workspaceRoot, patterns, "jest.config.*"),
		workspaceRoot,
		seenDirectories,
		packages,
	);

	assertNoDuplicateNames(packages, workspaceRoot);
	return packages;
}
