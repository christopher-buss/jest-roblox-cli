import { parseYAML } from "confbox";
import * as fs from "node:fs";
import * as path from "node:path";

import { createGlobCache, type GlobCache, globSync, matchesGlobPattern } from "../utils/glob.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";

const JEST_CONFIG_MARKER = /^jest\.config\.[^.]+$/;

const PACKAGE_JSON_LEAF = "package.json";
const JEST_CONFIG_LEAF = "jest.config.*";

export interface PackageInfo {
	name: string;
	packageDirectory: string;
}

/** See {@link enumerateWorkspacePackages}. */
export interface EnumerationOptions {
	/**
	 * Globs, relative to the workspace root, naming package directories
	 * workspace mode must never select on its own.
	 */
	exclude?: Array<string> | undefined;
	/** `workspace.packages`; omit to read `pnpm-workspace.yaml` instead. */
	patterns?: Array<string> | undefined;
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
	const packages =
		patterns !== undefined
			? enumerateFromGlobs(workspaceRoot, patterns)
			: listPnpmPackages(workspaceRoot);
	assertNoDuplicateNames(packages, workspaceRoot);
	return packages;
}

/**
 * Drop the packages an `exclude` glob names, matching each glob against the
 * package directory relative to the workspace root.
 *
 * Exported for the `--affected-since` source, which never reaches
 * {@link enumerateWorkspacePackages}: turbo and nx hand back directories
 * directly, and an excluded package that changed is still excluded.
 */
export function excludePackages(
	packages: Array<PackageInfo>,
	workspaceRoot: string,
	exclude: Array<string> | undefined,
): Array<PackageInfo> {
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
 * Distinct from {@link listPackages}, which answers "which packages exist" for
 * a name lookup. A package with no jest config is not a candidate here — a bare
 * `--workspace` would otherwise pick up every library in the repo — but naming
 * it through `--packages` still resolves, so the run fails on the missing
 * config rather than on a package that reads as absent.
 */
export function enumerateWorkspacePackages(
	workspaceRoot: string,
	{ exclude, patterns }: EnumerationOptions = {},
): Array<PackageInfo> {
	// Both filters sit here, downstream of the fork, so a source answers
	// only "which packages exist" and never gets a say in which of them a run
	// may select. A source that applied its own gate would make the exclude
	// depend on which one answered — and adding a third (a package manager's
	// install-time snapshot, say) would silently skip both.
	const cache = createGlobCache([PACKAGE_JSON_LEAF, JEST_CONFIG_LEAF]);
	const candidates =
		patterns !== undefined
			? enumerateFromGlobs(workspaceRoot, patterns, cache)
			: listPnpmPackages(workspaceRoot, cache);
	const testable = withJestConfig(candidates, workspaceRoot, cache);
	// After the exclude, not before: an excluded fixture sharing a name with a
	// real package would otherwise fail the run it was excluded from.
	const selected = excludePackages(testable, workspaceRoot, exclude);
	assertNoDuplicateNames(selected, workspaceRoot);
	return selected;
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

/**
 * Every path under `workspaceRoot` that `patterns` select with `leaf`
 * appended, minus the ones a `!` pattern excludes.
 *
 * `!` carries pnpm's meaning, because `pnpm-workspace.yaml` is one of the two
 * sources read here and its entries are the user's, not ours: a repo that keeps
 * its fixtures out of the package manager's workspace has said so already, and
 * enumerating them anyway would contradict a file we claim to read.
 */
function matchUnderPatterns(
	workspaceRoot: string,
	patterns: Array<string>,
	leaf: string,
	cache?: GlobCache,
): Array<string> {
	// One walk of the workspace root serves every pattern, and the leaves it was
	// declared for are the only files it keeps — one per package rather than
	// every file in the checkout.
	const globCache = cache ?? createGlobCache([leaf]);
	// `path.posix.join` reads a blank entry as the root, which would select a
	// package nobody asked for.
	const named = patterns.filter((pattern) => pattern.trim() !== "");

	// The leaf goes onto a negation exactly as it goes onto a positive pattern,
	// so a `!` glob filters manifest paths rather than directories. That is
	// pnpm's own rule (`normalizePatterns` appends the manifest name to every
	// entry) and it is not equivalent: `**` collapses to zero segments before
	// the leaf, so `!**/out-tsc/**` drops a package whose directory *is*
	// `out-tsc`, and `!packages/*/**` drops `packages/a` — neither of which a
	// directory match catches.
	//
	// Order-independent, unlike pnpm's sequential application: a negation that
	// precedes the pattern it narrows still applies, which is how every
	// pnpm-workspace.yaml in the wild is written anyway.
	const excluded = named
		.filter((pattern) => pattern.startsWith("!"))
		.map((pattern) => pattern.slice(1))
		// A bare `!` leaves nothing to exclude, and joining the leaf onto an
		// empty body yields the leaf itself — which is the workspace root's own
		// manifest, so the entry would delete the root rather than no-op.
		.filter((body) => body !== "")
		.map((body) => path.posix.join(body, leaf));
	const matches = named
		.filter((pattern) => !pattern.startsWith("!"))
		.flatMap((pattern) => {
			return globSync(path.posix.join(pattern, leaf), {
				cache: globCache,
				cwd: workspaceRoot,
			});
		});

	return matches.filter((match) => {
		return excluded.every((pattern) => !matchesGlobPattern(match, pattern));
	});
}

function listPnpmPackages(workspaceRoot: string, cache?: GlobCache): Array<PackageInfo> {
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
	for (const match of matchUnderPatterns(workspaceRoot, patterns, PACKAGE_JSON_LEAF, cache)) {
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

function enumerateFromGlobs(
	workspaceRoot: string,
	patterns: Array<string>,
	cache?: GlobCache,
): Array<PackageInfo> {
	const seenDirectories = new Set<string>();
	const packages: Array<PackageInfo> = [];

	collectPackagesFromMatches(
		matchUnderPatterns(workspaceRoot, patterns, JEST_CONFIG_LEAF, cache),
		workspaceRoot,
		seenDirectories,
		packages,
	);

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
 */
function withJestConfig(
	packages: Array<PackageInfo>,
	workspaceRoot: string,
	cache: GlobCache,
): Array<PackageInfo> {
	const configDirectories = new Set(
		matchUnderPatterns(workspaceRoot, ["**"], JEST_CONFIG_LEAF, cache)
			// The glob accepts the dots a `jest.config.spec.ts` carries; the
			// marker is what holds the leaf to a single suffix.
			.filter((match) => JEST_CONFIG_MARKER.test(path.basename(match)))
			.map((match) => path.dirname(path.join(workspaceRoot, match))),
	);
	return packages.filter((info) => configDirectories.has(info.packageDirectory));
}
