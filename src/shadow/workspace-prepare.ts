import * as crypto from "node:crypto";
import * as path from "node:path";
import picomatch from "picomatch";

import type { BuildManifestArtifact } from "../coverage-data/build-manifest.ts";
import {
	BUILD_MANIFEST_FILE,
	emitBuildManifest,
	toBuildManifestFiles,
} from "../coverage-data/build-manifest.ts";
import type { CoverageManifest } from "../coverage-data/manifest.ts";
import { writeManifest } from "../coverage-data/manifest.ts";
import { createCopyIgnoreMatcher } from "../instrument/discover-files.ts";
import {
	createInstrumentUniverse,
	type InstrumentUniverse,
} from "../instrument/instrument-universe.ts";
import { type Instrumenter, nodeInstrumenter } from "../instrument/instrumenter.ts";
import { NOOP_TIMING_COLLECTOR, type TimingCollector } from "../timing/orchestration-collector.ts";
import { nodeTsconfigReader, type TsconfigReader } from "../tsconfig/tsconfig-mappings.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import type { CoverageRoot } from "./coverage-root.ts";
import type { NarrowedMount } from "./narrow-roots.ts";
import { createCoverageManifest, prepareShadowTree, type ShadowTree } from "./shadow-tree.ts";
import type { WorkspaceCoveragePackage } from "./workspace-prepare-types.ts";
import { narrowPackageRoots } from "./workspace-roots.ts";

/** One package's instrumented roots and their manifest. */
export interface WorkspacePackageCoverage {
	/** Ignore patterns instrumentation used, for the report. */
	coveragePathIgnorePatterns: Array<string>;
	/** Instrumented roots paired with their shadow directories. */
	coverageRoots: Array<CoverageRoot>;
	/** Spine levels above each root, paired with their shadow copies. */
	coverageSpine: Array<CoverageRoot>;
	/** The package's written Coverage Manifest. */
	manifest: CoverageManifest;
	/** Where `manifest` was written. */
	manifestPath: string;
	/** Package name. */
	pkg: string;
	/** The anchor this package's coverage globs were resolved against. */
	rootDir: string;
}

/** Inputs for instrumenting every workspace package. */
export interface PrepareWorkspaceCoverageOptions {
	/** Workspace cache directory the package shadows are written under. */
	cacheDirectory: string;
	/** Where the shadows are built. Defaults to the real filesystem. */
	fileSystem: FileSystem;
	/** What writes the instrumented twins. Defaults to the real one. */
	instrumenter?: Instrumenter | undefined;
	/** Packages to instrument. */
	packages: Array<WorkspaceCoveragePackage>;
	/** Orchestration profiler for the coverage sub-phases. */
	timing?: TimingCollector | undefined;
	/** Reads each package tsconfig for compiled output roots. */
	tsconfigReader?: TsconfigReader;
}

interface PackagePaths {
	manifestPath: string;
	packageShadowRoot: string;
}

interface PreparePackageOptions {
	cacheDirectory: string;
	coveragePackage: WorkspaceCoveragePackage;
	fileSystem: FileSystem;
	instrumenter: Instrumenter;
	timing: TimingCollector;
	tsconfigReader: TsconfigReader;
}

/**
 * Instruments each package into its own shadow and writes its manifest.
 * @param options - Packages, workspace root and collaborators.
 * @returns One entry per package, in input order.
 */
export function prepareWorkspaceCoverage(
	options: PrepareWorkspaceCoverageOptions,
): Array<WorkspacePackageCoverage> {
	const {
		cacheDirectory,
		fileSystem,
		instrumenter = nodeInstrumenter,
		packages,
		tsconfigReader = nodeTsconfigReader,
	} = options;
	const timing = options.timing ?? NOOP_TIMING_COLLECTOR;

	return packages.map((coveragePackage) => {
		return prepareForPackage({
			cacheDirectory,
			coveragePackage,
			fileSystem,
			instrumenter,
			timing,
			tsconfigReader,
		});
	});
}

/**
 * Emits a Build Manifest beside each package's Coverage Manifest.
 * @param options - The shared coverage place, the package entries and the file
 * system.
 */
export function emitWorkspaceBuildManifests({
	coveragePlace,
	entries,
	fileSystem,
	rebuilt,
}: {
	coveragePlace: BuildManifestArtifact;
	entries: Array<WorkspacePackageCoverage>;
	fileSystem: FileSystem;
	rebuilt: boolean;
}): void {
	if (!rebuilt) {
		return;
	}

	for (const entry of entries) {
		const generatedAt = new Date();
		entry.manifest.buildId = crypto.randomUUID();
		entry.manifest.generatedAt = generatedAt.toISOString();
		writeManifest({ filePath: entry.manifestPath, fileSystem, manifest: entry.manifest });
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

function safePackageName(name: string): string {
	return name.replaceAll("/", "-");
}

function resolvePackagePaths(name: string, cacheDirectory: string): PackagePaths {
	const packageShadowRoot = path.join(cacheDirectory, safePackageName(name), "coverage");

	return {
		manifestPath: normalizeWindowsPath(path.join(packageShadowRoot, "coverage-manifest.json")),
		packageShadowRoot,
	};
}

function resolvePackageUniverse(
	coveragePackage: WorkspaceCoveragePackage,
	fileSystem: FileSystem,
): InstrumentUniverse | undefined {
	return createInstrumentUniverse(
		{
			ignore: coveragePackage.coveragePathIgnorePatterns,
			include: coveragePackage.collectCoverageFrom,
			rootDir: coveragePackage.rootDir,
		},
		fileSystem,
	);
}

function narrowPackage(
	coveragePackage: WorkspaceCoveragePackage,
	{
		fileSystem,
		tsconfigReader,
		universe,
	}: {
		fileSystem: FileSystem;
		tsconfigReader: TsconfigReader;
		universe: InstrumentUniverse | undefined;
	},
): Array<NarrowedMount> {
	return narrowPackageRoots({
		descriptor: coveragePackage,
		fileSystem,
		ignore: {
			copyMatcher: createCopyIgnoreMatcher(coveragePackage.coverageCopyIgnorePatterns),
			matcher: picomatch(coveragePackage.coveragePathIgnorePatterns, { contains: true }),
		},
		tsconfigReader,
		universe,
	});
}

function workspaceManifest(shadow: ShadowTree): CoverageManifest {
	const manifest =
		shadow.previousManifest ?? createCoverageManifest(shadow, { buildId: crypto.randomUUID() });
	return {
		...createCoverageManifest(shadow, { buildId: manifest.buildId }),
		generatedAt: manifest.generatedAt,
	};
}

function prepareForPackage({
	cacheDirectory,
	coveragePackage,
	fileSystem,
	instrumenter,
	timing,
	tsconfigReader,
}: PreparePackageOptions): WorkspacePackageCoverage {
	const paths = resolvePackagePaths(coveragePackage.name, cacheDirectory);
	const { manifestPath } = paths;
	const universe = resolvePackageUniverse(coveragePackage, fileSystem);
	const shadow = prepareShadowTree({
		fileSystem,
		instrumenter,
		manifestLabel: "Workspace coverage manifest",
		manifestPath,
		narrowed: narrowPackage(coveragePackage, { fileSystem, tsconfigReader, universe }),
		settings: coveragePackage,
		shadowRoot: paths.packageShadowRoot,
		sourcePrefix: coveragePackage.packageDirectory,
		timing,
		universe,
	});
	const manifest = workspaceManifest(shadow);
	writeManifest({ filePath: manifestPath, fileSystem, manifest });

	return {
		coveragePathIgnorePatterns: coveragePackage.coveragePathIgnorePatterns,
		coverageRoots: shadow.coverageRoots,
		coverageSpine: shadow.coverageSpine,
		manifest,
		manifestPath,
		pkg: coveragePackage.name,
		rootDir: coveragePackage.rootDir,
	};
}
