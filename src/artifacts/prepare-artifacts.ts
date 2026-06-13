import * as path from "node:path";

import { mergeCliWithConfig } from "../config/merge.ts";
import { resolveAllProjects } from "../config/projects.ts";
import type { CliOptions, ResolvedConfig } from "../config/schema.ts";
import type { AttributionResult } from "../coverage-pipeline/attribution.ts";
import { applyAttribution } from "../coverage-pipeline/attribution.ts";
import type {
	BuildManifestArtifact,
	BuildManifestProject,
} from "../coverage-pipeline/build-manifest.ts";
import { emitBuildManifest } from "../coverage-pipeline/build-manifest.ts";
import { readManifest, writeManifest } from "../coverage-pipeline/manifest.ts";
import {
	COVERAGE_BUILD_MANIFEST_PATH,
	COVERAGE_MANIFEST_PATH,
	findRojoProject,
} from "../coverage-pipeline/prepare.ts";
import type { RawCoverageData } from "../coverage-pipeline/types.ts";
import { getRawProjects, runSingleOrMulti } from "../run.ts";
import { collectStubMounts, loadRojoTree } from "../run/multi.ts";
import type { MultiRunResult, SingleRunResult } from "../run/types.ts";
import { buildPlace } from "../staging/place-builder.ts";
import type { PackageDescriptor } from "../staging/synthesizer.ts";
import { createTimingCollector } from "../timing/orchestration-collector.ts";

const COVERAGE_DIR = path.dirname(COVERAGE_BUILD_MANIFEST_PATH);
const CLEAN_PLACE_FILE = path.join(COVERAGE_DIR, "clean.rbxl");
const CLEAN_PROJECT_FILE = path.join(COVERAGE_DIR, "clean.project.json");
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
	coverageData?: RawCoverageData;
	coverageManifestPath: string;
	coveragePlace: BuildManifestArtifact;
	/** Per-project DataModel paths the kernel consumes, resolved from the run. */
	projects: Array<BuildManifestProject>;
}

/**
 * The sole producer of a Clean Place. Builds the Coverage-Instrumented Place and
 * runs the instrumented suite once (via the shared single/multi core), builds an
 * uninstrumented Clean Place through the Place Builder, then emits the Build
 * Manifest with both places in a single atomic write. `runJestRoblox` / the CLI
 * never build a Clean Place — opting in is calling this entry point.
 */
export async function prepareArtifacts(config: ResolvedConfig): Promise<ArtifactBundle> {
	const cli: CliOptions = {};
	const timing = createTimingCollector();
	try {
		const merged = mergeCliWithConfig(cli, {
			...config,
			collectCoverage: true,
			collectPerTestCoverage: true,
		});
		const result = await runSingleOrMulti(cli, merged, timing);

		const { coverageArtifacts } = result;
		if (coverageArtifacts === undefined) {
			throw new Error(
				"prepareArtifacts: the coverage run produced no artifacts. Ensure the project has runtime tests and that `typecheckOnly` is not set.",
			);
		}

		const cleanPlace = await buildCleanPlace(merged);

		// One atomic write that knows both places — never write-then-patch.
		emitBuildManifest(COVERAGE_BUILD_MANIFEST_PATH, coverageArtifacts, cleanPlace);

		// Fold per-test attribution into the coverage manifest the instrument
		// step already published, so the consumer reads tests[] + coveringTestIds
		// from the same artifact as the file records.
		writeManifestAttribution(COVERAGE_MANIFEST_PATH, extractAttribution(result));

		return {
			buildId: coverageArtifacts.buildId,
			buildManifestPath: COVERAGE_BUILD_MANIFEST_PATH,
			cleanPlace,
			coverageData: extractCoverageData(result),
			coverageManifestPath: COVERAGE_MANIFEST_PATH,
			coveragePlace: coverageArtifacts.coveragePlace,
			projects: coverageArtifacts.projects,
		};
	} finally {
		timing.flushTimingReport();
	}
}

function extractCoverageData(
	result: MultiRunResult | SingleRunResult,
): RawCoverageData | undefined {
	return result.mode === "single"
		? result.runtimeResult?.coverageData
		: result.merged.coverageData;
}

function extractAttribution(
	result: MultiRunResult | SingleRunResult,
): AttributionResult | undefined {
	return result.mode === "single" ? result.runtimeResult?.attribution : result.merged.attribution;
}

/**
 * Re-publish the coverage manifest with attribution folded in. A missing or
 * unreadable manifest, or a run that produced no attribution, is a no-op — the
 * file records the instrument step wrote stay as published.
 */
function writeManifestAttribution(
	manifestPath: string,
	attribution: AttributionResult | undefined,
): void {
	if (attribution === undefined) {
		return;
	}

	const read = readManifest(manifestPath);
	if (read.kind === "ok") {
		writeManifest(manifestPath, applyAttribution(read.manifest, attribution));
	}
}

/**
 * Build the uninstrumented Clean Place from the same rojo project as the
 * Coverage-Instrumented Place, minus `coverageRoots`. In multi mode the place
 * carries the same `jest.config` stub mounts the coverage run already wrote to
 * the cache, so the Clean Place is runnable.
 */
async function buildCleanPlace(config: ResolvedConfig): Promise<BuildManifestArtifact> {
	const descriptor: PackageDescriptor = {
		name: "jest-roblox-clean",
		packageDirectory: path.resolve(config.rootDir),
		rojoProjectPath: path.resolve(findRojoProject(config)),
	};

	const rawProjects = getRawProjects(config);
	if (rawProjects !== undefined && rawProjects.length > 0) {
		const cacheRoot = path.resolve(config.rootDir, CACHE_DIR);
		const rojoTree = loadRojoTree(config);
		const projects = await resolveAllProjects(rawProjects, config, rojoTree, config.rootDir);
		descriptor.stubMounts = collectStubMounts(projects, config.rootDir, cacheRoot);
	}

	return buildPlace({
		packages: [descriptor],
		placeFile: CLEAN_PLACE_FILE,
		projectFile: CLEAN_PROJECT_FILE,
		wrap: false,
	});
}
