import { parseYAML } from "confbox";
import * as path from "node:path";

import { applyExcludes } from "../config/apply-excludes.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { createGlobCache, type GlobCache, globSync } from "../utils/glob.ts";
import { PNPM_MARKER } from "./discovery.ts";
import type { PackageInfo } from "./package-info-types.ts";
import { readPnpmWorkspaceProjects } from "./pnpm-workspace-state.ts";

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
 * Every path under `workspaceRoot` that `patterns` select with `leaf`
 * appended, minus the ones a `!` pattern excludes.
 *
 * `!` carries pnpm's meaning, because `pnpm-workspace.yaml` is one of the two
 * sources read here and its entries are the user's, not ours: a repo that keeps
 * its fixtures out of the package manager's workspace has said so already, and
 * enumerating them anyway would contradict a file we claim to read.
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
	const excludeGlobs = new Set<string>();
	const matches = new Set<string>();
	for (const pattern of named) {
		if (pattern.startsWith("!")) {
			const body = pattern.slice(1);
			// A bare `!` leaves nothing to exclude, and joining the leaf onto
			// an empty body yields the leaf itself — the workspace root's own
			// manifest, so the entry would delete the root rather than
			// no-op.
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

/**
 * Find `pnpm-workspace.yaml` at the workspace root.
 * @param fileSystem - File system to probe.
 * @param workspaceRoot - Workspace root directory.
 * @returns The path to the workspace manifest, which is known to exist.
 * @throws {Error} When the manifest is absent.
 */
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
 * @param options - Walk inputs.
 * @param options.cache - Glob cache to reuse, if any.
 * @param options.fileSystem - File system to walk.
 * @param options.workspaceRoot - Workspace root directory.
 * @returns The packages the manifest patterns select.
 * @throws {Error} When `pnpm-workspace.yaml` is absent.
 */
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
	// pnpm reads the root manifest as a workspace project whether or not
	// `packages:` lists `.`, and does not subject it to the exclusions, so the
	// root leads the list rather than waiting on a pattern to select it.
	const matches = [PACKAGE_JSON_LEAF];
	if (yaml.packages !== undefined) {
		const walk = { cache, fileSystem, leaf: PACKAGE_JSON_LEAF, workspaceRoot };
		matches.push(...matchUnderPatterns({ ...walk, patterns: yaml.packages }));
	}

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
