import assert from "node:assert";

import { mergeCliWithConfig } from "../config/merge.ts";
import type { ResolvedConfig } from "../config/resolved-config.ts";
import { withRojoProject } from "../config/rojo-project.ts";
import type {
	BuildManifestArtifact,
	BuildManifestProject,
} from "../coverage-data/build-manifest.ts";
import { resolveCoverageLayout } from "../coverage-data/coverage-layout.ts";
import type { RunEntryOptions } from "../run/run-entry-options.ts";
import { settleRunEntry } from "../run/run-entry-options.ts";
import { resolveRunProjectsAsync } from "../run/single-projects.ts";
import { stageRunAsync } from "../run/staging.ts";
import { NOOP_TIMING_COLLECTOR } from "../timing/orchestration-collector.ts";

/** The offline-built coverage place and its manifest paths. */
export interface CoveragePlaceBundle {
	/** Build id shared by the place and its sibling manifests. */
	buildId: string;
	/** The always-on build record's path (`build-manifest.json`). */
	buildManifestPath: string;
	/** The coverage-data sibling manifest's path (`coverage-manifest.json`). */
	coverageManifestPath: string;
	/** The instrumented place: cwd-relative path + SHA-256 of its bytes. */
	coveragePlace: BuildManifestArtifact;
	/** Per-project DataModel paths baked into the place. */
	projects: Array<BuildManifestProject>;
	/** `false` when the place was reused unchanged. */
	rebuilt: boolean;
}

/**
 * Build the coverage-instrumented place with baked stubs, without running it.
 * @param config - Resolved config; coverage collection is forced on.
 * @param options - Optional file system and run seams.
 * @returns The built place, its manifest paths and the baked projects.
 */
export async function buildCoveragePlaceAsync(
	config: ResolvedConfig,
	options: RunEntryOptions = {},
): Promise<CoveragePlaceBundle> {
	const { fileSystem, seams } = settleRunEntry(options);
	const rootConfig = withRojoProject(
		mergeCliWithConfig({}, { ...config, collectCoverage: true }),
		fileSystem,
	);
	const run = { fileSystem, rootConfig, seams, timing: NOOP_TIMING_COLLECTOR };
	const projects = await resolveRunProjectsAsync({ ...run, cliTypecheck: {} });
	const { coverageArtifacts } = await stageRunAsync({ ...run, projects });
	assert(coverageArtifacts !== undefined, "a coverage run stages its coverage artifacts");

	const layout = resolveCoverageLayout(rootConfig.rootDir);
	return {
		buildId: coverageArtifacts.buildId,
		buildManifestPath: layout.buildManifestPath,
		coverageManifestPath: layout.manifestPath,
		coveragePlace: coverageArtifacts.coveragePlace,
		projects: coverageArtifacts.projects,
		rebuilt: coverageArtifacts.rebuilt,
	};
}
