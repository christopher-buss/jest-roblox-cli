import { parseYAML } from "confbox";
import * as fs from "node:fs";
import * as path from "node:path";

import { globSync } from "../utils/glob.ts";

const JEST_CONFIG_MARKER = /^jest\.config\.[^.]+$/;
const TRAILING_SLASH = /\/$/;

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

	const nameValue = Reflect.get(raw, "name");
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

function parsePackageJson(packageJsonPath: string): unknown {
	const contents = fs.readFileSync(packageJsonPath, "utf-8");
	try {
		return JSON.parse(contents);
	} catch (err) {
		throw new Error(`Failed to parse ${packageJsonPath}.`, { cause: err });
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
	for (const pattern of patterns) {
		const packageJsonPattern = `${pattern.replace(TRAILING_SLASH, "")}/package.json`;
		const matches = globSync(packageJsonPattern, { cwd: workspaceRoot });
		for (const match of matches) {
			const packageJsonPath = path.join(workspaceRoot, match);
			const name = readPackageJsonName(packageJsonPath);
			if (name !== undefined) {
				packages.push({ name, packageDirectory: path.dirname(packageJsonPath) });
			}
		}
	}

	return packages;
}

function assertNoDuplicateNames(packages: Array<PackageInfo>, workspaceRoot: string): void {
	const byName = new Map<string, Array<string>>();
	for (const package_ of packages) {
		const relative = path
			.relative(workspaceRoot, package_.packageDirectory)
			.replaceAll("\\", "/");
		const list = byName.get(package_.name) ?? [];
		list.push(relative);
		byName.set(package_.name, list);
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

	for (const pattern of patterns) {
		const jestConfigPattern = `${pattern.replace(TRAILING_SLASH, "")}/jest.config.*`;
		const matches = globSync(jestConfigPattern, { cwd: workspaceRoot });
		collectPackagesFromMatches(matches, workspaceRoot, seenDirectories, packages);
	}

	assertNoDuplicateNames(packages, workspaceRoot);
	return packages;
}
