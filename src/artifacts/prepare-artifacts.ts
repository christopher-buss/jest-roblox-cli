import * as path from "node:path";

import type { AttributionResult } from "../attribution/attribution.ts";
import { applyAttribution, mergeAttribution } from "../attribution/attribution.ts";
import { mergeCliWithConfig } from "../config/merge.ts";
import type { CliOptions, ResolvedConfig } from "../config/resolved-config.ts";
import { requireRojoProject, withRojoProject } from "../config/rojo-project.ts";
import type {
	BuildManifestArtifact,
	BuildManifestProject,
	CoverageArtifacts,
} from "../coverage-data/build-manifest.ts";
import { emitBuildManifest } from "../coverage-data/build-manifest.ts";
import type { CoverageLayout } from "../coverage-data/coverage-layout.ts";
import { resolveCoverageLayout } from "../coverage-data/coverage-layout.ts";
import type { RawCoverageData } from "../coverage-data/coverage-types.ts";
import type { CoverageManifest } from "../coverage-data/manifest.ts";
import { readManifest, writeManifest } from "../coverage-data/manifest.ts";
import { mergeRawCoverage } from "../coverage-data/merge-raw-coverage.ts";
import type { InstrumentUniverse } from "../instrument/instrument-universe.ts";
import { NOOP_RUN_PROGRESS, type RunProgress } from "../progress/run-progress.ts";
import type { ProjectResult } from "../results/run-result-types.ts";
import { runProjectLayoutAsync } from "../run/project-layout.ts";
import type { RunEntryOptions } from "../run/run-entry-options.ts";
import { readTimingSetting, settleRunEntry } from "../run/run-entry-options.ts";
import type { RunSeams } from "../run/seams.ts";
import { resolveRunProjectsAsync } from "../run/single-projects.ts";
import { buildPlaceAsync } from "../staging/place-builder.ts";
import { stubCacheRoot } from "../staging/stage-stubs.ts";
import { collectStubMounts } from "../staging/stubs.ts";
import type { StubMount, UnwrappedPackageDescriptor } from "../staging/synthesizer-types.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import { createTimingCollector, NOOP_TIMING_COLLECTOR } from "../timing/orchestration-collector.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { computePlaceContentId } from "./place-content-id.ts";

/** Places, coverage data and manifest paths of one artifact run. */
export interface ArtifactBundle {
	/** Build id shared by both places and the sibling manifests. */
	buildId: string;
	/** The Build Manifest's path. */
	buildManifestPath: string;
	/** The uninstrumented Clean Place. */
	cleanPlace: BuildManifestArtifact;
	/** Coverage hit data from the instrumented run, if any. */
	coverageData?: RawCoverageData | undefined;
	/** The coverage-data sibling manifest's path. */
	coverageManifestPath: string;
	/** The Coverage-Instrumented Place. */
	coveragePlace: BuildManifestArtifact;
	/** Per-project DataModel paths the kernel consumes. */
	projects: Array<BuildManifestProject>;
}

/** Options for `prepareArtifactsAsync`. */
export interface PrepareArtifactsOptions extends RunEntryOptions {
	/** Instrument universe passed to the coverage step, if set. */
	instrumentUniverse?: InstrumentUniverse | undefined;
	/** Print the `[TIMING]` report. */
	timingReport?: boolean | undefined;
}

interface ProduceArtifactsOptions extends Required<RunEntryOptions> {
	config: ResolvedConfig;
	progress: RunProgress;
	timing: TimingCollector;
}

/**
 * Build both places, run the instrumented suite, and emit the Build Manifest.
 * @param config - Resolved config for the run.
 * @param options - Optional seams and instrument universe.
 * @returns Both places, coverage data and the manifest paths.
 */
export async function prepareArtifactsAsync(
	config: ResolvedConfig,
	{
		instrumentUniverse,
		timingReport = readTimingSetting(),
		...options
	}: PrepareArtifactsOptions = {},
): Promise<ArtifactBundle> {
	const { fileSystem, seams } = settleRunEntry(options);
	const timing = createTimingCollector({ enabled: timingReport });
	try {
		return await produceArtifactsAsync({
			config: withRojoProject(config, fileSystem),
			fileSystem,
			progress: NOOP_RUN_PROGRESS,
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

function requireCoverageArtifacts(
	coverageArtifacts: CoverageArtifacts | undefined,
): CoverageArtifacts {
	if (coverageArtifacts === undefined) {
		throw new Error(
			"prepareArtifacts: the coverage run produced no artifacts. Ensure the project has runtime tests and that `test.typecheck.only` is not set.",
		);
	}

	return coverageArtifacts;
}

function requireCoverageManifest(manifestPath: string, fileSystem: FileSystem): CoverageManifest {
	const read = readManifest(manifestPath, fileSystem);
	if (read.kind !== "ok") {
		throw new Error(
			`prepareArtifacts: could not read the coverage manifest at ${manifestPath}, so the Clean Place has no build to be stamped with.`,
		);
	}

	return read.manifest;
}

function writeManifestAttribution({
	attribution,
	fileSystem,
	layout,
	manifest,
}: {
	attribution: AttributionResult | undefined;
	fileSystem: FileSystem;
	layout: CoverageLayout;
	manifest: CoverageManifest;
}): void {
	if (attribution === undefined) {
		return;
	}

	writeManifest({
		filePath: layout.manifestPath,
		fileSystem,
		manifest: applyAttribution(manifest, attribution),
	});
}

async function resolveCleanStubMountsAsync(
	config: ResolvedConfig,
	entry: Required<RunEntryOptions>,
): Promise<Array<StubMount>> {
	return collectStubMounts({
		cacheRoot: stubCacheRoot(config.rootDir),
		projects: await resolveRunProjectsAsync({
			cliTypecheck: {},
			fileSystem: entry.fileSystem,
			rootConfig: config,
			seams: entry.seams,
			timing: NOOP_TIMING_COLLECTOR,
		}),
	});
}

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
	const layout = resolveCoverageLayout(config.rootDir);
	const descriptor: UnwrappedPackageDescriptor = {
		rojoProjectPath: requireRojoProject(config),
		stubMounts: await resolveCleanStubMountsAsync(config, entry),
	};

	const { artifact } = await buildPlaceAsync({
		childProcess: seams.childProcess,
		contentId,
		fileSystem,
		packages: [descriptor],
		placeFile: path.join(layout.placeDirectory, "clean.rbxl"),
		projectFile: path.join(layout.placeDirectory, "clean.project.json"),
		wrap: false,
	});
	return artifact;
}

function foldProjectCoverage(projectResults: Array<ProjectResult>): {
	attribution: AttributionResult | undefined;
	coverageData: RawCoverageData | undefined;
} {
	let attribution: AttributionResult | undefined;
	let coverageData: RawCoverageData | undefined;

	for (const { result } of projectResults) {
		coverageData = mergeRawCoverage(coverageData, result.coverageData);
		if (result.attribution !== undefined) {
			attribution =
				attribution === undefined
					? result.attribution
					: mergeAttribution(attribution, result.attribution);
		}
	}

	return { attribution, coverageData };
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
	const result = await runProjectLayoutAsync({ cli, rootConfig: merged, timing, ...entry });
	const artifacts = requireCoverageArtifacts(result.coverageArtifacts);
	const layout = resolveCoverageLayout(merged.rootDir);
	const coverageManifest = requireCoverageManifest(layout.manifestPath, fileSystem);
	const cleanPlace = await buildCleanPlaceAsync({
		config: merged,
		contentId: computePlaceContentId(coverageManifest),
		entry,
	});

	emitBuildManifest({ artifacts, cleanPlace, filePath: layout.buildManifestPath, fileSystem });

	const { attribution, coverageData } = foldProjectCoverage(result.projectResults);
	writeManifestAttribution({ attribution, fileSystem, layout, manifest: coverageManifest });

	return {
		buildId: artifacts.buildId,
		buildManifestPath: layout.buildManifestPath,
		cleanPlace,
		coverageData,
		coverageManifestPath: layout.manifestPath,
		coveragePlace: artifacts.coveragePlace,
		projects: artifacts.projects,
	};
}
