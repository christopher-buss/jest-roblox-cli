import * as crypto from "node:crypto";
import * as path from "node:path";
import picomatch from "picomatch";

import { DEFAULT_CONFIG } from "../config/schema.ts";
import { NOOP_TIMING_COLLECTOR, type TimingCollector } from "../timing/orchestration-collector.ts";
import { atomicWrite } from "../utils/atomic-write.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import type { BuildManifestArtifact } from "./build-manifest.ts";
import { BUILD_MANIFEST_FILE, emitBuildManifest, toBuildManifestFiles } from "./build-manifest.ts";
import type { CopyIgnoreMatcher } from "./discover-files.ts";
import { createCopyIgnoreMatcher, hashCopyIgnorePatterns } from "./discover-files.ts";
import type { InstrumentUniverse } from "./instrument-universe.ts";
import { createInstrumentUniverse } from "./instrument-universe.ts";
import type { Instrumenter } from "./instrumenter.ts";
import { INSTRUMENTER_VERSION, nodeInstrumenter } from "./instrumenter.ts";
import type { CoverageManifest } from "./manifest.ts";
import { MANIFEST_VERSION } from "./manifest.ts";
import { instrumentPackage } from "./workspace-instrument.ts";
import type {
	InstrumentedPackage,
	PackageIgnore,
	WorkspaceCoverageRoot,
	WorkspacePackageDescriptor,
} from "./workspace-prepare-types.ts";

const WORKSPACE_COVERAGE_DIR = ".jest-roblox/workspace";

/**
 * One package's instrumented roots and the manifest that describes them.
 */
export interface WorkspacePackageCoverage {
	/**
	 * This package's effective `coveragePathIgnorePatterns` (per-package
	 * override or the `DEFAULT_CONFIG` fallback). Always populated by
	 * `prepareForPackage`; optional only so test stubs need not restate it.
	 * Carried so report-time aggregation applies the same patterns per-package
	 * that instrumentation used for roots.
	 */
	coveragePathIgnorePatterns?: Array<string> | undefined;
	/**
	 * Instrumented roots paired with their shadow directories; empty when the
	 * package has none.
	 */
	coverageRoots: Array<WorkspaceCoverageRoot>;
	/**
	 * The directories between each `coverageRoots` entry and the `$path` mount
	 * above it, paired with the shadow copy of that directory's own loose
	 * files. Synthesis demotes each one so the roots below it can be swapped.
	 */
	coverageSpine: Array<WorkspaceCoverageRoot>;
	/**
	 * The package's written Coverage Manifest.
	 */
	manifest: CoverageManifest;
	/**
	 * Where `manifest` was written.
	 */
	manifestPath: string;
	/**
	 * Package name.
	 */
	pkg: string;
	/**
	 * The anchor this package's coverage globs were resolved against. Carried
	 * for the same reason as `coveragePathIgnorePatterns`: the report has to
	 * judge on exactly what instrumentation judged on, and re-deriving the
	 * anchor from a config downstream is how the two would drift apart.
	 */
	rootDir: string;
}

/**
 * Inputs for instrumenting every workspace package.
 */
export interface PrepareWorkspaceCoverageOptions {
	/** Where the shadows are built. Defaults to the real filesystem. */
	fileSystem?: FileSystem;
	/** What writes the instrumented twins. Defaults to the real one. */
	instrumenter?: Instrumenter | undefined;
	/**
	 * Packages to instrument.
	 */
	packages: Array<WorkspacePackageDescriptor>;
	/**
	 * Orchestration profiler; records the coverage sub-phases per instrumented
	 * root.
	 */
	timing?: TimingCollector | undefined;
	/**
	 * Directory under which `.jest-roblox/workspace` is written.
	 */
	workspaceRoot: string;
}

/** Where one package's coverage artifacts are published. */
interface PackagePaths {
	manifestPath: string;
	packageShadowRoot: string;
}

/** What one package's whole coverage pass reads. */
interface PreparePackageOptions {
	descriptor: WorkspacePackageDescriptor;
	fileSystem: FileSystem;
	ignore: PackageIgnore;
	instrumenter: Instrumenter;
	timing: TimingCollector;
	workspaceRoot: string;
}

/** One package's manifest write, after its roots are instrumented. */
interface WritePackageManifestOptions {
	copyIgnoreHash: string;
	fileSystem: FileSystem;
	instrumented: InstrumentedPackage;
	manifestPath: string;
	packageShadowRoot: string;
	universe: InstrumentUniverse | undefined;
}

/**
 * Instrument each workspace package into its own shadow directory and write a
 * per-package manifest. Returns one `WorkspacePackageCoverage` entry per input
 * package; packages with no instrumentable luau roots return an empty
 * `coverageRoots` array (the caller then skips coverage rewrites for that
 * package while still picking up an empty manifest for parity).
 * @param options - Packages, workspace root and collaborators.
 * @returns One entry per package, in input order.
 */
export function prepareWorkspaceCoverage(
	options: PrepareWorkspaceCoverageOptions,
): Array<WorkspacePackageCoverage> {
	const {
		fileSystem = nodeFileSystem,
		instrumenter = nodeInstrumenter,
		packages,
		workspaceRoot,
	} = options;
	const timing = options.timing ?? NOOP_TIMING_COLLECTOR;
	// Workspace mode reads `coveragePathIgnorePatterns` per-package only.
	// Hoist the DEFAULT_CONFIG matcher so packages that don't override the
	// field share one picomatch compile; the workspace-root config is
	// intentionally not threaded through here.
	const defaultMatcher = createIgnoreMatcher(DEFAULT_CONFIG.coveragePathIgnorePatterns);
	// Hoisted for the same reason, one knob over: nothing else in the workspace
	// re-parses the defaults per package.
	const defaultCopyMatcher = createCopyIgnoreMatcher(DEFAULT_CONFIG.coverageCopyIgnorePatterns);

	return packages.map((descriptor) => {
		return prepareForPackage({
			descriptor,
			fileSystem,
			ignore: resolvePackageIgnore({ defaultCopyMatcher, defaultMatcher, descriptor }),
			instrumenter,
			timing,
			workspaceRoot,
		});
	});
}

/**
 * Emit a per-package Build Manifest next to each Coverage Manifest, after the
 * shared place build has succeeded. Every package records the one shared
 * instrumented place as its `coveragePlace` and reuses its Coverage Manifest's
 * `buildId`, so the sibling manifests cross-link. `projects` is left empty for
 * a later slice to populate, and no Clean Place is emitted from the workspace
 * path (it records `coveragePlace` only).
 * @param options - The shared coverage place, the package entries and the file
 * system.
 */
export function emitWorkspaceBuildManifests({
	coveragePlace,
	entries,
	fileSystem = nodeFileSystem,
}: {
	coveragePlace: BuildManifestArtifact;
	entries: Array<WorkspacePackageCoverage>;
	fileSystem?: FileSystem;
}): void {
	for (const entry of entries) {
		// The Build Manifest is the Coverage Manifest's sibling — same directory.
		const buildManifestPath = normalizeWindowsPath(
			path.join(path.dirname(entry.manifestPath), BUILD_MANIFEST_FILE),
		);
		emitBuildManifest({
			artifacts: {
				buildId: entry.manifest.buildId,
				coveragePlace,
				files: toBuildManifestFiles(entry.manifest.files),
				generatedAt: entry.manifest.generatedAt,
				projects: [],
			},
			filePath: buildManifestPath,
			fileSystem,
		});
	}
}

/**
 * Map an npm-style package name (`@scope/name`) to a filesystem-safe directory
 * segment. Replaces "/" with "-" so the on-disk path is one segment deep.
 * @param name - Package name, possibly `@scope/`-prefixed.
 * @returns Directory segment.
 */
function safePackageName(name: string): string {
	return name.replaceAll("/", "-");
}

/**
 * Where one package's shadow tree and its Coverage Manifest live on disk.
 * @param name - Package name, possibly `@scope/`-prefixed.
 * @param workspaceRoot - Directory that holds `.jest-roblox/workspace`.
 * @returns Shadow root and normalized manifest path.
 */
function resolvePackagePaths(name: string, workspaceRoot: string): PackagePaths {
	const packageShadowRoot = path.join(
		workspaceRoot,
		WORKSPACE_COVERAGE_DIR,
		safePackageName(name),
		"coverage",
	);

	return {
		manifestPath: normalizeWindowsPath(path.join(packageShadowRoot, "coverage-manifest.json")),
		packageShadowRoot,
	};
}

function writePackageManifest({
	copyIgnoreHash,
	fileSystem,
	instrumented,
	manifestPath,
	packageShadowRoot,
	universe,
}: WritePackageManifestOptions): CoverageManifest {
	const generatedAtDate = new Date();
	const manifest: CoverageManifest = {
		buildId: crypto.randomUUID(),
		copyIgnoreHash,
		coverageUniverseHash: universe?.digest,
		files: instrumented.files,
		generatedAt: generatedAtDate.toISOString(),
		instrumenterVersion: INSTRUMENTER_VERSION,
		luauRoots: instrumented.coverageRoots.map((entry) => entry.shadowDir),
		nonInstrumentedFiles: instrumented.nonInstrumentedFiles,
		shadowDir: normalizeWindowsPath(packageShadowRoot),
		version: MANIFEST_VERSION,
	};

	// atomicWrite creates the manifest's parent directory, so a package with no
	// instrumentable luau roots (the loop above ran zero times, leaving
	// packageShadowRoot uncreated) still gets a manifest written.
	atomicWrite({
		contents: JSON.stringify(manifest, undefined, "\t"),
		fileSystem,
		targetPath: manifestPath,
	});

	return manifest;
}

/**
 * The anchor this package's coverage globs resolve against. `rootDir` defaults
 * to the package directory the same way the config loader defaults it, so a
 * descriptor built by a caller with no coverage stake — the staging and
 * preflight paths — need not state one.
 * @param descriptor - Package whose anchor is resolved.
 * @returns The package's `rootDir`, else its directory.
 */
function resolvePackageAnchor(descriptor: WorkspacePackageDescriptor): string {
	return descriptor.rootDir ?? descriptor.packageDirectory;
}

/**
 * The package's coverage universe, built from the same patterns its own report
 * and threshold gate use — so a file earns probes exactly when that package
 * would report on it. `undefined` when the package names no coverage globs.
 *
 * Deliberately no `deriveCoverageFromIncludes` fallback, unlike multi mode:
 * the workspace report has none either (`workspace-aggregate.ts` filters on the
 * raw per-package value), and adding one here would probe against a universe
 * the package's own report never applies.
 * @param options - Package, its ignore settings and the file system.
 * @returns The universe, or `undefined` without coverage globs.
 */
function resolvePackageUniverse({
	descriptor,
	fileSystem,
	ignore,
}: {
	descriptor: WorkspacePackageDescriptor;
	fileSystem: FileSystem;
	ignore: PackageIgnore;
}): InstrumentUniverse | undefined {
	return createInstrumentUniverse(
		{
			ignore: ignore.patterns,
			include: descriptor.collectCoverageFrom,
			rootDir: resolvePackageAnchor(descriptor),
		},
		fileSystem,
	);
}

function prepareForPackage(options: PreparePackageOptions): WorkspacePackageCoverage {
	const { descriptor, fileSystem, ignore, workspaceRoot } = options;
	const { manifestPath, packageShadowRoot } = resolvePackagePaths(descriptor.name, workspaceRoot);

	const universe = resolvePackageUniverse({ descriptor, fileSystem, ignore });
	const instrumented = instrumentPackage({
		...options,
		manifestPath,
		packageShadowRoot,
		universe,
	});
	const manifest = writePackageManifest({
		copyIgnoreHash: ignore.copyDigest,
		fileSystem,
		instrumented,
		manifestPath,
		packageShadowRoot,
		universe,
	});

	return {
		coveragePathIgnorePatterns: ignore.patterns,
		coverageRoots: instrumented.coverageRoots,
		coverageSpine: instrumented.coverageSpine,
		manifest,
		manifestPath,
		pkg: descriptor.name,
		rootDir: resolvePackageAnchor(descriptor),
	};
}

function createIgnoreMatcher(patterns: Array<string>): (filePath: string) => boolean {
	return picomatch(patterns, { contains: true });
}

function resolvePackageIgnore({
	defaultCopyMatcher,
	defaultMatcher,
	descriptor,
}: {
	defaultCopyMatcher: CopyIgnoreMatcher;
	defaultMatcher: (filePath: string) => boolean;
	descriptor: WorkspacePackageDescriptor;
}): PackageIgnore {
	const copyPatterns =
		descriptor.coverageCopyIgnorePatterns ?? DEFAULT_CONFIG.coverageCopyIgnorePatterns;
	return {
		copyDigest: hashCopyIgnorePatterns(copyPatterns),
		copyMatcher:
			descriptor.coverageCopyIgnorePatterns !== undefined
				? createCopyIgnoreMatcher(descriptor.coverageCopyIgnorePatterns)
				: defaultCopyMatcher,
		matcher:
			descriptor.coveragePathIgnorePatterns !== undefined
				? createIgnoreMatcher(descriptor.coveragePathIgnorePatterns)
				: defaultMatcher,
		patterns:
			descriptor.coveragePathIgnorePatterns ?? DEFAULT_CONFIG.coveragePathIgnorePatterns,
	};
}
