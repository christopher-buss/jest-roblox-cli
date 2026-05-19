import { collectPaths, loadRojoProject, resolveNestedProjects } from "@isentinel/rojo-utils";

import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import picomatch from "picomatch";

import type { ResolvedConfig } from "../config/schema.ts";
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
	config: ResolvedConfig;
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
	const { config, packages, workspaceRoot } = options;
	const matchesIgnored = createIgnoreMatcher(config.coveragePathIgnorePatterns);

	return packages.map((descriptor) => {
		return prepareForPackage(descriptor, workspaceRoot, matchesIgnored, config);
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

function discoverPackageLuauRoots(
	descriptor: WorkspacePackageDescriptor,
	matchesIgnored: (filePath: string) => boolean,
): Array<string> {
	const project = loadRojoProject(descriptor.rojoProjectPath);
	const resolvedTree = resolveNestedProjects(
		project.tree,
		path.dirname(descriptor.rojoProjectPath),
	);

	const collected: Array<string> = [];
	collectPaths(resolvedTree, collected);

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

		// `isRbxtsIncludeRoot` (two `existsSync`s) precedes the recursive
		// `containsLuauFiles` scan so include dirs short-circuit out before
		// the deep walk.
		if (
			matchesIgnored(relative) ||
			!fs.existsSync(absolute) ||
			!fs.statSync(absolute).isDirectory() ||
			isRbxtsIncludeRoot(absolute) ||
			!containsLuauFiles(absolute) ||
			seen.has(relative)
		) {
			continue;
		}

		seen.add(relative);
		result.push(relative);
	}

	return result;
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
	config: ResolvedConfig,
): boolean {
	if (!config.coverageCache) {
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

function prepareForPackage(
	descriptor: WorkspacePackageDescriptor,
	workspaceRoot: string,
	matchesIgnored: (filePath: string) => boolean,
	config: ResolvedConfig,
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
	const useIncremental = canUseIncremental(previousManifest, config);

	// Mirror prepareCoverage's cold-path nuke (prepare.ts) so files deleted
	// from source between runs don't survive into the redirected `$path`
	// mount. `prepareShadowRoot`'s cpSync merges; without an explicit rmSync
	// here a stale `*.spec.luau` could still be discovered at runtime.
	if (!useIncremental && fs.existsSync(packageShadowRoot)) {
		fs.rmSync(packageShadowRoot, { recursive: true });
	}

	const luauRoots = discoverPackageLuauRoots(descriptor, matchesIgnored);

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
