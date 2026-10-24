import * as path from "node:path";

import { mergeCliWithConfig } from "../config/merge.ts";
import type { CliOptions, ResolvedConfig } from "../config/schema.ts";
import type { AttributionResult } from "../coverage-pipeline/attribution.ts";
import { applyAttribution } from "../coverage-pipeline/attribution.ts";
import type {
	BuildManifestArtifact,
	BuildManifestProject,
	CoverageArtifacts,
} from "../coverage-pipeline/build-manifest.ts";
import { emitBuildManifest } from "../coverage-pipeline/build-manifest.ts";
import type { InstrumentUniverse } from "../coverage-pipeline/instrument-universe.ts";
import type { CoverageManifest } from "../coverage-pipeline/manifest.ts";
import { readManifest, writeManifest } from "../coverage-pipeline/manifest.ts";
import { computePlaceContentId } from "../coverage-pipeline/place-content-id.ts";
import {
	COVERAGE_BUILD_MANIFEST_PATH,
	COVERAGE_MANIFEST_PATH,
	findRojoProject,
	PLACE_DIR,
} from "../coverage-pipeline/prepare.ts";
import type { RawCoverageData } from "../coverage-pipeline/types.ts";
import type { RunEntryOptions } from "../run.ts";
import { nodeRunDispatch, runSingleOrMultiAsync } from "../run.ts";
import type { RunSeams } from "../run/seams.ts";
import { nodeRunSeams } from "../run/seams.ts";
import { collectStubMounts } from "../run/staging.ts";
import { buildPlaceAsync } from "../staging/place-builder.ts";
import type { StubMount, UnwrappedPackageDescriptor } from "../staging/synthesizer.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import { createTimingCollector } from "../timing/orchestration-collector.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";

const CLEAN_PLACE_FILE = path.join(PLACE_DIR, "clean.rbxl");
const CLEAN_PROJECT_FILE = path.join(PLACE_DIR, "clean.project.json");
const CACHE_DIR = path.join(".jest-roblox", "cache");

/**
 * Everything a consumer (mutation-tester, `flux`) needs from one artifact-
 * production run: the two distinct places, the coverage hit data, and the paths
 * of the sibling manifests, all sharing one `buildId`.
 */
export interface ArtifactBundle {
	buildId: string;
	buildManifestPath: string;
	cleanPlace: BuildManifestArtifact;
	coverageData?: RawCoverageData | undefined;
	coverageManifestPath: string;
	coveragePlace: BuildManifestArtifact;
	/**
	 * Per-project DataModel paths the kernel consumes, resolved from the run.
	 */
	projects: Array<BuildManifestProject>;
}

export interface PrepareArtifactsOptions extends RunEntryOptions {
	instrumentUniverse?: InstrumentUniverse | undefined;
}

interface ProduceArtifactsOptions extends Required<RunEntryOptions> {
	config: ResolvedConfig;
	timing: TimingCollector;
}

/**
 * The sole producer of a Clean Place. Builds the Coverage-Instrumented Place
 * and runs the instrumented suite once (via the shared single/multi core),
 * builds an uninstrumented Clean Place through the Place Builder, then emits
 * the Build Manifest with both places in a single atomic write.
 * `runJestRobloxAsync` / the CLI never build a Clean Place — opting in is
 * calling this entry point.
 */
export async function prepareArtifactsAsync(
	config: ResolvedConfig,
	{
		dispatch = nodeRunDispatch(),
		fileSystem = nodeFileSystem,
		instrumentUniverse,
		seams = nodeRunSeams(),
	}: PrepareArtifactsOptions = {},
): Promise<ArtifactBundle> {
	const timing = createTimingCollector();
	try {
		return await produceArtifactsAsync({
			config,
			dispatch,
			fileSystem,
			seams: withInstrumentUniverse(seams, instrumentUniverse),
			timing,
		});
	} finally {
		timing.flushTimingReport();
	}
}

function withInstrumentUniverse(
	seams: RunSeams,
	instrumentUniverse: InstrumentUniverse | undefined,
): RunSeams {
	if (instrumentUniverse === undefined) {
		return seams;
	}

	return {
		...seams,
		prepareCoverage: async (config, options) => {
			return seams.prepareCoverage(config, { ...options, instrumentUniverse });
		},
	};
}

/**
 * A `typecheckOnly` config, or a project with no runtime tests, produces no
 * coverage artifacts — which makes the whole bundle meaningless. Fail loud
 * rather than emit a half-written Build Manifest.
 */
function requireCoverageArtifacts(
	coverageArtifacts: CoverageArtifacts | undefined,
): CoverageArtifacts {
	if (coverageArtifacts === undefined) {
		throw new Error(
			"prepareArtifacts: the coverage run produced no artifacts. Ensure the project has runtime tests and that `typecheckOnly` is not set.",
		);
	}

	return coverageArtifacts;
}

/**
 * The manifest the instrument step published for this run. Unreadable is a
 * fault rather than a degraded bundle: it is what the Place Content Id is taken
 * over, and a place stamped from anything less proves less than it claims.
 */
function requireCoverageManifest(manifestPath: string, fileSystem: FileSystem): CoverageManifest {
	const read = readManifest(manifestPath, fileSystem);
	if (read.kind !== "ok") {
		throw new Error(
			`prepareArtifacts: could not read the coverage manifest at ${manifestPath}, so the Clean Place has no build to be stamped with.`,
		);
	}

	return read.manifest;
}

/**
 * Re-publish the coverage manifest with attribution folded in. A run that
 * produced no attribution is a no-op — the file records the instrument step
 * wrote stay as published.
 */
function writeManifestAttribution({
	attribution,
	fileSystem,
	manifest,
}: {
	attribution: AttributionResult | undefined;
	fileSystem: FileSystem;
	manifest: CoverageManifest;
}): void {
	if (attribution === undefined) {
		return;
	}

	writeManifest({
		filePath: COVERAGE_MANIFEST_PATH,
		fileSystem,
		manifest: applyAttribution(manifest, attribution),
	});
}

async function resolveCleanStubMountsAsync(
	config: ResolvedConfig,
	{ dispatch, fileSystem, seams }: Required<RunEntryOptions>,
): Promise<Array<StubMount> | undefined> {
	const rawProjects = config.projects;
	if (rawProjects === undefined || rawProjects.length === 0) {
		return undefined;
	}

	const projects = await seams.resolveAllProjects({
		cwd: config.rootDir,
		entries: rawProjects,
		fileSystem,
		rojoTree: dispatch.loadRojoTree(config, fileSystem),
		rootConfig: config,
		tsconfigReader: seams.tsconfigReader,
	});
	return collectStubMounts({
		cacheRoot: path.resolve(config.rootDir, CACHE_DIR),
		fileSystem,
		projects,
		rootDir: config.rootDir,
	});
}

/**
 * Build the uninstrumented Clean Place from the same rojo project as the
 * Coverage-Instrumented Place, minus `coverageRoots`. In multi mode the place
 * carries the same `jest.config` stub mounts the coverage run already wrote to
 * the cache, so the Clean Place is runnable.
 */
async function buildCleanPlaceAsync({
	config,
	contentId,
	entry,
}: {
	config: ResolvedConfig;
	contentId: string;
	entry: Required<RunEntryOptions>;
}): Promise<BuildManifestArtifact> {
	const { fileSystem, seams } = entry;
	const descriptor: UnwrappedPackageDescriptor = {
		packageDirectory: path.resolve(config.rootDir),
		rojoProjectPath: path.resolve(findRojoProject(config, fileSystem)),
		stubMounts: await resolveCleanStubMountsAsync(config, entry),
	};

	return buildPlaceAsync({
		childProcess: seams.childProcess,
		contentId,
		fileSystem,
		packages: [descriptor],
		placeFile: CLEAN_PLACE_FILE,
		projectFile: CLEAN_PROJECT_FILE,
		wrap: false,
	});
}

async function produceArtifactsAsync({
	config,
	timing,
	...entry
}: ProduceArtifactsOptions): Promise<ArtifactBundle> {
	const { fileSystem } = entry;
	const cli: CliOptions = {};
	const merged = mergeCliWithConfig(cli, {
		...config,
		collectCoverage: true,
		collectPerTestCoverage: true,
	});
	const result = await runSingleOrMultiAsync({ cli, rootConfig: merged, timing, ...entry });
	const artifacts = requireCoverageArtifacts(result.coverageArtifacts);
	const coverageManifest = requireCoverageManifest(COVERAGE_MANIFEST_PATH, fileSystem);
	const cleanPlace = await buildCleanPlaceAsync({
		config: merged,
		contentId: computePlaceContentId(coverageManifest),
		entry,
	});

	// One atomic write that knows both places — never write-then-patch.
	const filePath = COVERAGE_BUILD_MANIFEST_PATH;
	emitBuildManifest({ artifacts, cleanPlace, filePath, fileSystem });

	const { attribution } = result.merged;
	writeManifestAttribution({ attribution, fileSystem, manifest: coverageManifest });

	return {
		buildId: artifacts.buildId,
		buildManifestPath: COVERAGE_BUILD_MANIFEST_PATH,
		cleanPlace,
		coverageData: result.merged.coverageData,
		coverageManifestPath: COVERAGE_MANIFEST_PATH,
		coveragePlace: artifacts.coveragePlace,
		projects: artifacts.projects,
	};
}
