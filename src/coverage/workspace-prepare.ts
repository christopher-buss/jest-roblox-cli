import { collectPaths, loadRojoProject, resolveNestedProjects } from "@isentinel/rojo-utils";

import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import picomatch from "picomatch";

import { DEFAULT_CONFIG } from "../config/schema.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { INSTRUMENTER_VERSION } from "./instrumenter.ts";
import type {
	CoverageManifest,
	InstrumentedFileRecord,
	NonInstrumentedFileRecord,
} from "./manifest.ts";
import { MANIFEST_VERSION, readManifest } from "./manifest.ts";
import {
	cleanupDeletedFiles,
	detectDeletedFiles,
	isNonInstrumentedFile,
	prepareShadowRoot,
} from "./shadow-root.ts";

const WORKSPACE_COVERAGE_DIR = ".jest-roblox/workspace";

export interface WorkspacePackageDescriptor {
	name: string;
	/**
	 * Per-package `coverageCache` opt-out. When undefined, defaults to
	 * `DEFAULT_CONFIG.coverageCache` (true). Workspace mode reads this knob
	 * per-package only; the workspace-root `config.coverageCache` is
	 * intentionally not consulted.
	 */
	coverageCache?: boolean;
	/**
	 * Per-package `coveragePathIgnorePatterns`. When undefined, the matcher
	 * falls back to `DEFAULT_CONFIG.coveragePathIgnorePatterns` — workspace
	 * mode reads this knob per-package only. An empty array means "no
	 * ignore patterns" (user opted out of every default pattern).
	 */
	coveragePathIgnorePatterns?: Array<string>;
	/**
	 * Per-package override for `luauRoots`. When set to a non-empty array,
	 * `discoverPackageLuauRoots` skips the rojo-tree walk and uses these roots
	 * directly (after validating each entry against the rojo `$path` mounts).
	 * An empty array or undefined falls back to the rojo walk — matches single
	 * mode's `> 0` gate at `prepare.ts:resolveLuauRootsWithRojo`.
	 */
	luauRoots?: Array<string>;
	packageDirectory: string;
	rojoProjectPath: string;
}

export interface WorkspaceCoverageRoot {
	/** Path relative to the package directory (matches what rojo $path uses). */
	luauRoot: string;
	/** Absolute, POSIX-normalized path to the instrumented shadow directory. */
	shadowDir: string;
}

export interface WorkspacePackageCoverage {
	coverageRoots: Array<WorkspaceCoverageRoot>;
	manifest: CoverageManifest;
	manifestPath: string;
	pkg: string;
}

export interface PrepareWorkspaceCoverageOptions {
	packages: Array<WorkspacePackageDescriptor>;
	workspaceRoot: string;
}

/**
 * Instrument each workspace package into its own shadow directory and write a
 * per-package manifest. Returns one `WorkspacePackageCoverage` entry per input
 * package; packages with no instrumentable luau roots return an empty
 * `coverageRoots` array (the caller then skips coverage rewrites for that
 * package while still picking up an empty manifest for parity).
 */
export function prepareWorkspaceCoverage(
	options: PrepareWorkspaceCoverageOptions,
): Array<WorkspacePackageCoverage> {
	const { packages, workspaceRoot } = options;
	// Workspace mode reads `coveragePathIgnorePatterns` per-package only.
	// Hoist the DEFAULT_CONFIG matcher so packages that don't override the
	// field share one picomatch compile; the workspace-root config is
	// intentionally not threaded through here.
	const defaultMatcher = createIgnoreMatcher(DEFAULT_CONFIG.coveragePathIgnorePatterns);

	return packages.map((descriptor) => {
		const matchesIgnored =
			descriptor.coveragePathIgnorePatterns !== undefined
				? createIgnoreMatcher(descriptor.coveragePathIgnorePatterns)
				: defaultMatcher;
		return prepareForPackage(descriptor, workspaceRoot, matchesIgnored);
	});
}

function isInstrumentableLuauFile(filename: string): boolean {
	if (!filename.endsWith(".luau") && !filename.endsWith(".lua")) {
		return false;
	}

	// Mirror `parse-ast.luau`'s discovery filter: instrumentation skips spec,
	// test, and snapshot files. A directory containing only those would feed
	// `instrumentRoot` zero files and produce an empty shadow dir, which the
	// synthesizer would then swap a parent `$path` into and the demote pass
	// inside `walkToLeaf` would fail to walk. Defer the suffix set to
	// `shadow-root.ts`'s `NON_INSTRUMENTED_SUFFIXES` so this filter cannot
	// drift from the instrumenter's view.
	return !isNonInstrumentedFile(filename);
}

function containsLuauFiles(directoryPath: string): boolean {
	const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
	return entries.some((entry) => {
		if (entry.isFile() && isInstrumentableLuauFile(entry.name)) {
			return true;
		}

		if (entry.isDirectory()) {
			return containsLuauFiles(path.join(directoryPath, entry.name));
		}

		return false;
	});
}

// Mirrors the roblox-ts compiler: it emits `RuntimeLib.lua` (and `Promise.lua`)
// into the project's rbxts include dir. Instrumenting vendor code wastes work
// and forces every `TS.import` through cov probes.
function isRbxtsIncludeRoot(directoryPath: string): boolean {
	return (
		fs.existsSync(path.join(directoryPath, "RuntimeLib.lua")) ||
		fs.existsSync(path.join(directoryPath, "RuntimeLib.luau"))
	);
}

/**
 * Common filter applied to every candidate coverage root regardless of how it
 * was discovered (rojo walk or per-pkg `luauRoots`). Returns `true` when the
 * directory should be instrumented.
 *
 * `isRbxtsIncludeRoot` (two `existsSync`s) precedes the recursive
 * `containsLuauFiles` scan so include dirs short-circuit out before the deep
 * walk.
 */
function isInstrumentableRoot(
	absolutePath: string,
	relativePath: string,
	matchesIgnored: (filePath: string) => boolean,
): boolean {
	if (matchesIgnored(relativePath)) {
		return false;
	}

	if (!fs.existsSync(absolutePath)) {
		return false;
	}

	if (!fs.statSync(absolutePath).isDirectory()) {
		return false;
	}

	if (isRbxtsIncludeRoot(absolutePath)) {
		return false;
	}

	return containsLuauFiles(absolutePath);
}

function collectRojoMountedPaths(descriptor: WorkspacePackageDescriptor): Array<string> {
	const project = loadRojoProject(descriptor.rojoProjectPath);
	const resolvedTree = resolveNestedProjects(
		project.tree,
		path.dirname(descriptor.rojoProjectPath),
	);

	const collected: Array<string> = [];
	collectPaths(resolvedTree, collected);
	return collected;
}

/**
 * Returns the set of package-relative directory paths the rojo tree mounts.
 * Used by the per-pkg `luauRoots` short-circuit to validate that each user-
 * provided root corresponds to an actual `$path` mount — off-tree entries
 * become orphan instrumented code (shadow built, never loaded at runtime).
 */
function buildRojoMountSet(
	descriptor: WorkspacePackageDescriptor,
	collected: Array<string>,
): Set<string> {
	const rojoDirectory = path.dirname(descriptor.rojoProjectPath);
	const mounts = new Set<string>();
	for (const rawPath of collected) {
		const absolute = path.resolve(rojoDirectory, rawPath);
		const relative = normalizeWindowsPath(path.relative(descriptor.packageDirectory, absolute));
		if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
			continue;
		}

		mounts.add(relative);
	}

	return mounts;
}

/**
 * True when `candidate` is a rojo `$path` mount or is nested under one. A
 * `luauRoot: "src/Client"` is valid when rojo mounts either `src` or
 * `src/Client` (the synthesized rojo project still resolves the shadow at
 * runtime in either case).
 */
function isOnRojoTree(candidate: string, mounts: Set<string>): boolean {
	for (const mount of mounts) {
		if (candidate === mount) {
			return true;
		}

		if (candidate.startsWith(`${mount}/`)) {
			return true;
		}

		if (mount.startsWith(`${candidate}/`)) {
			return true;
		}
	}

	return false;
}

function discoverFromLuauRoots(
	descriptor: WorkspacePackageDescriptor,
	luauRoots: Array<string>,
	matchesIgnored: (filePath: string) => boolean,
): Array<string> {
	const mounts = buildRojoMountSet(descriptor, collectRojoMountedPaths(descriptor));
	const seen = new Set<string>();
	const result: Array<string> = [];
	for (const rawRoot of luauRoots) {
		const relative = normalizeWindowsPath(rawRoot);
		if (seen.has(relative)) {
			continue;
		}

		if (!isOnRojoTree(relative, mounts)) {
			process.stderr.write(
				`Warning: luauRoot "${rawRoot}" in ${descriptor.name} does not correspond to any rojo $path mount; coverage will be skipped for this root.\n`,
			);
			continue;
		}

		const absolute = path.resolve(descriptor.packageDirectory, relative);
		if (!isInstrumentableRoot(absolute, relative, matchesIgnored)) {
			continue;
		}

		seen.add(relative);
		result.push(relative);
	}

	return result;
}

function discoverFromRojoWalk(
	descriptor: WorkspacePackageDescriptor,
	matchesIgnored: (filePath: string) => boolean,
): Array<string> {
	const collected = collectRojoMountedPaths(descriptor);
	const rojoDirectory = path.dirname(descriptor.rojoProjectPath);
	const seen = new Set<string>();
	const result: Array<string> = [];
	for (const rawPath of collected) {
		// path.resolve treats absolute rawPaths as already-resolved (passes them
		// through verbatim) and resolves relative ones against the rojo dir, so
		// no separate isAbsolute branch is needed.
		const absolute = path.resolve(rojoDirectory, rawPath);
		const relative = normalizeWindowsPath(path.relative(descriptor.packageDirectory, absolute));
		if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
			continue;
		}

		if (seen.has(relative) || !isInstrumentableRoot(absolute, relative, matchesIgnored)) {
			continue;
		}

		seen.add(relative);
		result.push(relative);
	}

	return result;
}

function discoverPackageLuauRoots(
	descriptor: WorkspacePackageDescriptor,
	matchesIgnored: (filePath: string) => boolean,
): Array<string> {
	// Short-circuit when the package opts into explicit luauRoots — mirrors
	// single mode's `> 0` gate at `prepare.ts:resolveLuauRootsWithRojo:187`.
	// Empty array falls through to the rojo walk (auto-detect).
	if (descriptor.luauRoots !== undefined && descriptor.luauRoots.length > 0) {
		return discoverFromLuauRoots(descriptor, descriptor.luauRoots, matchesIgnored);
	}

	return discoverFromRojoWalk(descriptor, matchesIgnored);
}

/**
 * Map an npm-style package name (`@scope/name`) to a filesystem-safe directory
 * segment. Replaces "/" with "-" so the on-disk path is one segment deep.
 */
function safePackageName(name: string): string {
	return name.replaceAll("/", "-");
}

function loadPackageManifest(manifestPath: string): CoverageManifest | undefined {
	const result = readManifest(manifestPath);
	switch (result.kind) {
		case "invalid": {
			process.stderr.write(
				`Warning: Workspace coverage manifest is invalid (cache discarded): ${result.summary}\n`,
			);
			return undefined;
		}
		case "malformed-json": {
			process.stderr.write(
				"Warning: Workspace coverage manifest is malformed JSON (cache discarded)\n",
			);
			return undefined;
		}
		case "missing":
		case "version-mismatch": {
			return undefined;
		}
		case "ok": {
			return result.manifest;
		}
	}
}

function canUseIncremental(
	previousManifest: CoverageManifest | undefined,
	coverageCache: boolean,
): boolean {
	if (!coverageCache) {
		return false;
	}

	if (previousManifest === undefined) {
		return false;
	}

	if (previousManifest.instrumenterVersion !== INSTRUMENTER_VERSION) {
		return false;
	}

	return true;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) {
		return false;
	}

	for (const value of a) {
		if (!b.has(value)) {
			return false;
		}
	}

	return true;
}

function prepareForPackage(
	descriptor: WorkspacePackageDescriptor,
	workspaceRoot: string,
	matchesIgnored: (filePath: string) => boolean,
): WorkspacePackageCoverage {
	const safeName = safePackageName(descriptor.name);
	const packageShadowRoot = path.join(
		workspaceRoot,
		WORKSPACE_COVERAGE_DIR,
		safeName,
		"coverage",
	);
	const manifestPath = normalizeWindowsPath(path.join(packageShadowRoot, "manifest.json"));

	const previousManifest = loadPackageManifest(manifestPath);
	const coverageCache = descriptor.coverageCache ?? DEFAULT_CONFIG.coverageCache;
	let useIncremental = canUseIncremental(previousManifest, coverageCache);

	const luauRoots = discoverPackageLuauRoots(descriptor, matchesIgnored);

	// HAL-215: when the user shrinks `luauRoots` (or adds new ignore patterns)
	// between runs, previously-instrumented mounts disappear from the new set
	// but their shadow files remain on disk. `prepareShadowRoot` only merges
	// (cpSync), so a stale `vendored-packages/dep/init.luau` would survive
	// into the redirected `$path` mount and the runtime would load it. Force
	// a cold rebuild for that package so the rmSync below nukes the shadow.
	if (useIncremental && previousManifest !== undefined) {
		const computedShadowDirectories = new Set(
			luauRoots.map((relative) =>
				normalizeWindowsPath(path.join(packageShadowRoot, relative)),
			),
		);
		const previousShadowDirectories = new Set(previousManifest.luauRoots);
		if (!setsEqual(computedShadowDirectories, previousShadowDirectories)) {
			useIncremental = false;
		}
	}

	// Mirror prepareCoverage's cold-path nuke (prepare.ts) so files deleted
	// from source between runs don't survive into the redirected `$path`
	// mount. `prepareShadowRoot`'s cpSync merges; without an explicit rmSync
	// here a stale `*.spec.luau` could still be discovered at runtime.
	if (!useIncremental && fs.existsSync(packageShadowRoot)) {
		fs.rmSync(packageShadowRoot, { recursive: true });
	}

	const coverageRoots: Array<WorkspaceCoverageRoot> = [];
	const allFiles: Record<string, InstrumentedFileRecord> = {};
	const allNonInstrumented: Record<string, NonInstrumentedFileRecord> = {};

	for (const relativeLuauRoot of luauRoots) {
		const absoluteSourceRoot = normalizeWindowsPath(
			path.join(descriptor.packageDirectory, relativeLuauRoot),
		);
		const shadowDirectory = normalizeWindowsPath(
			path.join(packageShadowRoot, relativeLuauRoot),
		);

		const result = prepareShadowRoot({
			luauRoot: absoluteSourceRoot,
			previousManifest,
			shadowDir: shadowDirectory,
			useIncremental,
		});

		Object.assign(allFiles, result.files);
		Object.assign(allNonInstrumented, result.nonInstrumentedFiles);
		coverageRoots.push({ luauRoot: relativeLuauRoot, shadowDir: shadowDirectory });
	}

	if (useIncremental && previousManifest !== undefined) {
		const deleted = detectDeletedFiles(previousManifest, allFiles);
		cleanupDeletedFiles(deleted);
	}

	const manifest: CoverageManifest = {
		files: allFiles,
		generatedAt: new Date().toISOString(),
		instrumenterVersion: INSTRUMENTER_VERSION,
		luauRoots: coverageRoots.map((entry) => entry.shadowDir),
		nonInstrumentedFiles: allNonInstrumented,
		shadowDir: normalizeWindowsPath(packageShadowRoot),
		version: MANIFEST_VERSION,
	};

	// Ensure the manifest's parent directory exists even when the loop above
	// ran zero times (package with no instrumentable luau roots). The
	// in-loop mkdirSync targets the shadow subdir, which only handles
	// packages that actually had roots.
	fs.mkdirSync(packageShadowRoot, { recursive: true });
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, undefined, "\t"));

	return { coverageRoots, manifest, manifestPath, pkg: descriptor.name };
}

function createIgnoreMatcher(patterns: Array<string>): (filePath: string) => boolean {
	if (patterns.length === 0) {
		return () => false;
	}

	return picomatch(patterns, { contains: true });
}
