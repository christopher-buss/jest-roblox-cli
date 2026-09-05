import { parseYAML } from "confbox";
import * as path from "node:path";

import { applyExcludes } from "../config/apply-excludes.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { createGlobCache, type GlobCache, globSync, matchesGlobPattern } from "../utils/glob.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { PNPM_MARKER } from "./discovery.ts";
import type { PackageInfo } from "./package-info.ts";
import { readPnpmWorkspaceProjects } from "./pnpm-workspace-state.ts";

const JEST_CONFIG_MARKER = /^jest\.config\.[^.]+$/;

const PACKAGE_JSON_LEAF = "package.json";
const JEST_CONFIG_LEAF = "jest.config.*";

export type { PackageInfo } from "./package-info.ts";

/** See {@link enumerateWorkspacePackages}. */
export interface EnumerationOptions {
	/**
	 * Globs, relative to the workspace root, naming package directories
	 * workspace mode must never select on its own.
	 */
	exclude?: Array<string> | undefined;
	/** Where the walk reads. Defaults to the real filesystem. */
	fileSystem?: FileSystem;
	/** `workspace.packages`; omit to read `pnpm-workspace.yaml` instead. */
	patterns?: Array<string> | undefined;
}

export interface ResolvePackagesOptions {
	/** Where the walk reads. Defaults to the real filesystem. */
	fileSystem?: FileSystem;
	/**
	 * `workspace.packages` globs. Their presence is what selects the
	 * jest-config-glob source over the pnpm workspace.
	 */
	patterns?: Array<string> | undefined;
}

interface PnpmWorkspace {
	packages?: Array<string>;
}

/** A checkout to enumerate: what reads it, and where its root is. */
interface WorkspaceWalk {
	fileSystem: FileSystem;
	workspaceRoot: string;
}

export function readPackageJsonName(
	packageJsonPath: string,
	fileSystem: FileSystem = nodeFileSystem,
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
 * Enumerate workspace packages. With `patterns` (from `workspace.packages`),
 * resolve directories by globbing for a `jest.config.*` — works in any repo,
 * including Luau-only / npm / yarn workspaces with no `pnpm-workspace.yaml`.
 * Without `patterns`, fall back to reading `pnpm-workspace.yaml`.
 */
export function listPackages(
	workspaceRoot: string,
	{ fileSystem = nodeFileSystem, patterns }: ResolvePackagesOptions = {},
): Array<PackageInfo> {
	const packages =
		patterns !== undefined
			? enumerateFromGlobs(fileSystem, workspaceRoot, patterns)
			: pnpmPackages(fileSystem, workspaceRoot, []);
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
			? enumerateFromGlobs(fileSystem, workspaceRoot, patterns, cache)
			: pnpmPackages(fileSystem, workspaceRoot, [], cache);
	const testable = withJestConfig(fileSystem, candidates, workspaceRoot, cache);
	// After the exclude, not before: an excluded fixture sharing a name with a
	// real package would otherwise fail the run it was excluded from.
	const selected = excludePackages(testable, workspaceRoot, exclude);
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
 */
export function resolvePackages(
	workspaceRoot: string,
	names: Array<string>,
	{ fileSystem = nodeFileSystem, patterns }: ResolvePackagesOptions = {},
): Array<PackageInfo> {
	const packages =
		patterns !== undefined
			? listPackages(workspaceRoot, { fileSystem, patterns })
			: pnpmPackages(fileSystem, workspaceRoot, names);
	assertNoDuplicateNames(packages, workspaceRoot);
	return names.map((name) => findOrThrow(packages, name));
}

function parsePackageJson(fileSystem: FileSystem, packageJsonPath: string): JSONValue {
	const contents = fileSystem.readFileSync(packageJsonPath, "utf-8");
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
	{ fileSystem, workspaceRoot }: WorkspaceWalk,
	patterns: Array<string>,
	leaf: string,
	cache?: GlobCache,
): Array<string> {
	// One walk of the workspace root serves every pattern, and the leaves it was
	// declared for are the only files it keeps — one per package rather than
	// every file in the checkout.
	const globCache = cache ?? createGlobCache([leaf]);
	// `path.posix.join` reads a blank entry as the root, which would select a
	// package nobody asked for. Only the empty string does that — a
	// whitespace-only entry joins to a directory name of spaces, which matches
	// nothing on its own.
	//
	// Untrimmed here and everywhere below, because pnpm does not trim its
	// `packages:` entries either: ` !packages/a ` is a positive pattern that
	// matches nothing there, not an exclusion. Trimming would invent an
	// exclusion pnpm never applies and drop a package the user still has.
	const named = patterns.filter((pattern) => pattern !== "");

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
	//
	// Subtracted from the matches rather than globbed a second time: an
	// exclusion only ever removes what a positive pattern already selected, so
	// it costs a pass over those few paths instead of over the whole walk.
	const excludeGlobs = named
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
				fileSystem,
			});
		});

	return applyExcludes(matches, excludeGlobs);
}

/** @returns The path to the workspace manifest, which is known to exist. */
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

/**
 * Enumerate by walking the repo, for when no snapshot is available.
 *
 * The walk cannot see a package in a dot-directory — `glob.ts` skips those, so
 * that `.git` and `.nx` cost nothing on the test discovery it also serves — so
 * a workspace that lists one (`.bedrock`, `.sandcastle`) resolves it only
 * through the snapshot.
 */
function walkPnpmPackages(
	fileSystem: FileSystem,
	workspaceRoot: string,
	cache?: GlobCache,
): Array<PackageInfo> {
	const yamlPath = assertPnpmWorkspace(fileSystem, workspaceRoot);
	const yaml = parseYAML<PnpmWorkspace>(fileSystem.readFileSync(yamlPath, "utf-8"));
	const patterns = yaml.packages ?? [];

	const packages: Array<PackageInfo> = [];
	const seenDirectories = new Set<string>();
	// pnpm reads the root manifest as a workspace project whether or not
	// `packages:` lists `.`, and does not subject it to the exclusions, so the
	// root leads the list rather than waiting on a pattern to select it.
	const matches = [
		PACKAGE_JSON_LEAF,
		...matchUnderPatterns({ fileSystem, workspaceRoot }, patterns, PACKAGE_JSON_LEAF, cache),
	];

	for (const match of matches) {
		const packageJsonPath = path.join(workspaceRoot, match);
		const packageDirectory = path.dirname(packageJsonPath);
		// Overlapping patterns — `packages/*` beside `packages/foo` — select
		// the same package twice.
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

function findByName(packages: Array<PackageInfo>, name: string): PackageInfo | undefined {
	return packages.find((candidate) => candidate.name === name);
}

/**
 * The packages of a pnpm workspace: from the snapshot pnpm wrote at install
 * time when it can answer for `names`, and from a walk of the repo when it
 * cannot.
 *
 * The single place that choice is made, and `names` is what decides it. A
 * package added since the last install is real but unrecorded, so a name the
 * snapshot lacks is not an answer — only the walk tells "absent" apart from
 * "newer than the snapshot". An empty `names` asks nothing of it, so the
 * snapshot stands.
 *
 * No manifest check of its own: a workspace with no `pnpm-workspace.yaml`
 * reads as untrustworthy here and reaches {@link walkPnpmPackages}, which is
 * where the error naming the missing file belongs.
 */
function pnpmPackages(
	fileSystem: FileSystem,
	workspaceRoot: string,
	names: Array<string>,
	cache?: GlobCache,
): Array<PackageInfo> {
	const snapshot = readPnpmWorkspaceProjects(workspaceRoot, fileSystem);
	if (snapshot !== undefined) {
		assertNoDuplicateNames(snapshot, workspaceRoot);
		if (names.every((name) => findByName(snapshot, name) !== undefined)) {
			return snapshot;
		}
	}

	return walkPnpmPackages(fileSystem, workspaceRoot, cache);
}

function inferPackageName(fileSystem: FileSystem, packageDirectory: string): string {
	const packageJsonPath = path.join(packageDirectory, PACKAGE_JSON_LEAF);
	return readPackageJsonName(packageJsonPath, fileSystem) ?? path.basename(packageDirectory);
}

function collectPackagesFromMatches(
	{ fileSystem, workspaceRoot }: WorkspaceWalk,
	matches: Array<string>,
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
		packages.push({ name: inferPackageName(fileSystem, packageDirectory), packageDirectory });
	}
}

function enumerateFromGlobs(
	fileSystem: FileSystem,
	workspaceRoot: string,
	patterns: Array<string>,
	cache?: GlobCache,
): Array<PackageInfo> {
	const seenDirectories = new Set<string>();
	const packages: Array<PackageInfo> = [];

	collectPackagesFromMatches(
		{ fileSystem, workspaceRoot },
		matchUnderPatterns({ fileSystem, workspaceRoot }, patterns, JEST_CONFIG_LEAF, cache),
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
	fileSystem: FileSystem,
	packages: Array<PackageInfo>,
	workspaceRoot: string,
	cache: GlobCache,
): Array<PackageInfo> {
	const configDirectories = new Set(
		matchUnderPatterns({ fileSystem, workspaceRoot }, ["**"], JEST_CONFIG_LEAF, cache)
			// The glob accepts the dots a `jest.config.spec.ts` carries; the
			// marker is what holds the leaf to a single suffix.
			.filter((match) => JEST_CONFIG_MARKER.test(path.basename(match)))
			.map((match) => path.dirname(path.join(workspaceRoot, match))),
	);
	return packages.filter((info) => configDirectories.has(info.packageDirectory));
}

function findOrThrow(packages: Array<PackageInfo>, name: string): PackageInfo {
	const match = findByName(packages, name);
	if (match !== undefined) {
		return match;
	}

	const names = packages.map((candidate) => candidate.name).join(", ");
	throw new Error(`Package "${name}" not found in workspace. Available: ${names}`);
}
