import * as path from "node:path";

import { mergeCliWithConfig } from "../config/merge.ts";
import { resolveAllProjects } from "../config/projects.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import type { CliOptions, ResolvedConfig } from "../config/schema.ts";
import { cleanLeftoverStubs, generateProjectStubs } from "../config/stubs.ts";
import type {
	BuildManifestArtifact,
	BuildManifestProject,
} from "../coverage-pipeline/build-manifest.ts";
import { emitBuildManifest } from "../coverage-pipeline/build-manifest.ts";
import {
	COVERAGE_BUILD_MANIFEST_PATH,
	COVERAGE_MANIFEST_PATH,
} from "../coverage-pipeline/prepare.ts";
import { getRawProjects } from "../run.ts";
import { loadRojoTree, prepareBakedCoverage } from "../run/multi.ts";
import { buildImplicitProject } from "../run/single-projects.ts";

const CACHE_DIR = path.join(".jest-roblox", "cache");

/**
 * Everything a caller (a Node-only "Machine A") needs after producing the
 * coverage-instrumented place offline, without executing any suite: the built
 * place (`coveragePlace.path` + content hash) and the paths of the sibling
 * manifests it shares a `buildId` with. The place is left on disk for the caller
 * to copy to the run machine — it is never cleaned.
 */
export interface CoveragePlaceBundle {
	buildId: string;
	/** The always-on build record's path (`build-manifest.json`). */
	buildManifestPath: string;
	/** The coverage-data sibling manifest's path (`coverage-manifest.json`). */
	coverageManifestPath: string;
	/** The instrumented place: cwd-relative path + SHA-256 of its bytes. */
	coveragePlace: BuildManifestArtifact;
	/** Per-project DataModel paths baked into the place. */
	projects: Array<BuildManifestProject>;
	/** `false` on the incremental no-change reuse path (place was not rebuilt). */
	rebuilt: boolean;
}

/**
 * Build the coverage-instrumented place **without running it** — the offline
 * half of the split producer. Instruments (incrementally) and rojo-builds the
 * place, bakes each project's `jest.config` stub into it so any runner that
 * opens the place can discover and run the suite unaided, publishes the sibling
 * Build + Coverage manifests, and hands back the place. No backend is resolved,
 * no suite executes, nothing hits the network. Coverage collection is forced on
 * regardless of the input config.
 *
 * The counterpart to `prepareArtifacts`, minus the run and the Clean Place —
 * the entry point for a machine that cannot execute Roblox at all. It shares the
 * `prepareBakedCoverage` seam with the run path but always bakes stubs (the run
 * path skips baking for studio-cli, which injects configs at runtime), because a
 * place handed to a foreign runner must be self-contained.
 */
export async function buildCoveragePlace(config: ResolvedConfig): Promise<CoveragePlaceBundle> {
	const cli: CliOptions = {};
	const merged = mergeCliWithConfig(cli, { ...config, collectCoverage: true });

	const projects = await resolveProjects(merged);

	const cacheRoot = path.resolve(merged.rootDir, CACHE_DIR);
	// Mirror the run path's pre-flight: drop marker-bearing leftover stubs, then
	// regenerate the current set into the cache (never the user's source tree) so
	// `prepareBakedCoverage` can bake them into the place.
	cleanLeftoverStubs(projects, merged.rootDir);
	generateProjectStubs(projects, merged.rootDir, cacheRoot);

	const { artifacts } = prepareBakedCoverage(merged, projects, cacheRoot, true);

	// Emit only when the place was rebuilt this run, matching `runJestRoblox`:
	// the reuse path leaves the prior (still-valid) build manifest in place, and
	// `prepareCoverage`'s reuse gate already re-validated it against disk.
	if (artifacts.rebuilt) {
		emitBuildManifest(COVERAGE_BUILD_MANIFEST_PATH, artifacts);
	}

	return {
		buildId: artifacts.buildId,
		buildManifestPath: COVERAGE_BUILD_MANIFEST_PATH,
		coverageManifestPath: COVERAGE_MANIFEST_PATH,
		coveragePlace: artifacts.coveragePlace,
		projects: artifacts.projects,
		rebuilt: artifacts.rebuilt,
	};
}

/**
 * Resolve the project set the place is built from, mirroring `runSingleOrMulti`
 * dispatch: an explicit `projects:` config resolves through `resolveAllProjects`;
 * a bare config collapses to the single implicit project derived from its luau
 * roots. Type-only configs are irrelevant here — a build always instruments.
 */
async function resolveProjects(config: ResolvedConfig): Promise<Array<ResolvedProjectConfig>> {
	const rojoTree = loadRojoTree(config);
	const rawProjects = getRawProjects(config);
	if (rawProjects !== undefined && rawProjects.length > 0) {
		return resolveAllProjects(rawProjects, config, rojoTree, config.rootDir);
	}

	return [buildImplicitProject(config, rojoTree)];
}
