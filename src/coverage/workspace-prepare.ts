import { collectPaths, loadRojoProject, resolveNestedProjects } from "@isentinel/rojo-utils";

import * as fs from "node:fs";
import * as path from "node:path";
import picomatch from "picomatch";

import type { ResolvedConfig } from "../config/schema.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { INSTRUMENTER_VERSION, instrumentRoot } from "./instrumenter.ts";
import type { CoverageManifest, InstrumentedFileRecord } from "./types.ts";

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
		return prepareForPackage(descriptor, workspaceRoot, matchesIgnored);
	});
}

function containsLuauFiles(directoryPath: string): boolean {
	const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
	return entries.some((entry) => {
		if (entry.isFile() && entry.name.endsWith(".luau")) {
			return true;
		}

		if (entry.isDirectory()) {
			return containsLuauFiles(path.join(directoryPath, entry.name));
		}

		return false;
	});
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

		if (matchesIgnored(relative)) {
			continue;
		}

		if (!fs.existsSync(absolute)) {
			continue;
		}

		if (!fs.statSync(absolute).isDirectory()) {
			continue;
		}

		if (!containsLuauFiles(absolute)) {
			continue;
		}

		if (seen.has(relative)) {
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

	const luauRoots = discoverPackageLuauRoots(descriptor, matchesIgnored);

	const coverageRoots: Array<WorkspaceCoverageRoot> = [];
	const allFiles: Record<string, InstrumentedFileRecord> = {};

	for (const relativeLuauRoot of luauRoots) {
		const absoluteSourceRoot = normalizeWindowsPath(
			path.join(descriptor.packageDirectory, relativeLuauRoot),
		);
		const shadowDirectory = normalizeWindowsPath(
			path.join(packageShadowRoot, relativeLuauRoot),
		);

		fs.mkdirSync(shadowDirectory, { recursive: true });

		const files = instrumentRoot({
			luauRoot: absoluteSourceRoot,
			shadowDir: shadowDirectory,
		});
		Object.assign(allFiles, files);
		coverageRoots.push({ luauRoot: relativeLuauRoot, shadowDir: shadowDirectory });
	}

	const manifest: CoverageManifest = {
		files: allFiles,
		generatedAt: new Date().toISOString(),
		instrumenterVersion: INSTRUMENTER_VERSION,
		luauRoots: coverageRoots.map((entry) => entry.shadowDir),
		nonInstrumentedFiles: {},
		shadowDir: normalizeWindowsPath(packageShadowRoot),
		version: 1,
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
