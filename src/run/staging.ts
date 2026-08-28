import * as path from "node:path";
import process from "node:process";

import type { ResolvedProjectConfig } from "../config/projects.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import {
	cleanLeftoverStubs,
	generateProjectStubs,
	hasUserAuthoredConfig,
	STUB_FILENAME,
	syncStubsToShadowDirectory,
} from "../config/stubs.ts";
import type { CoverageArtifacts } from "../coverage-pipeline/build-manifest.ts";
import { resolveCoverageInclude } from "../coverage-pipeline/derive-coverage-from.ts";
import type { PrepareCoverageResult } from "../coverage-pipeline/prepare.ts";
import { prepareCoverage, toCoverageArtifacts } from "../coverage-pipeline/prepare.ts";
import type { StubMount } from "../staging/synthesizer.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import { toBuildManifestProjects } from "./manifest-projects.ts";

/**
 * Everything the run path needs on disk before a backend exists: where the
 * generated `jest.config` stubs live, and the config the run actually executes
 * against (which differs from the root config only in `placeFile`, when
 * coverage rebuilt the place).
 */
export interface StagedRun extends StagedCoverage {
	cacheRoot: string;
	/**
	 * Host time spent putting this run's inputs on disk: the stub sweep and
	 * generation, plus — on a coverage run — the stub bake and the instrumented
	 * place build. The instrumentation is timed apart as `coverageMs`, and the
	 * place build a non-coverage run does later adds onto this.
	 */
	stagingMs: number;
}

export interface BakedCoverage {
	artifacts: CoverageArtifacts;
	coverage: PrepareCoverageResult;
}

/**
 * The `--coverage` half of a staged run; absent fields when coverage is off.
 */
interface StagedCoverage {
	coverageArtifacts?: CoverageArtifacts | undefined;
	coverageMs: number;
	effectiveConfig: ResolvedConfig;
}

/**
 * {@link StagedCoverage} plus the part of the bake the run reports as staging
 * rather than as coverage — the stub sync and the place build. `stageRun` folds
 * it into `stagingMs`, so the field travels no further.
 */
interface StagedCoverageRun extends StagedCoverage {
	coverageStagingMs: number;
}

/**
 * `jest.config` stub mounts for a place build: one `$path` named-child per
 * rojo mount that lacks a user-authored config on disk, pointing at the cache
 * stub. Shared by the open-cloud place build and `prepareArtifacts`'s Clean
 * Place.
 */
export function collectStubMounts(
	projects: Array<ResolvedProjectConfig>,
	rootDirectory: string,
	cacheRoot: string,
): Array<StubMount> {
	// Per-mount FS check decides whether to inject. A TS string-entry may or may
	// not have a compiled `.luau` at the mount yet — trust the filesystem rather
	// than the entry shape.
	const stubMounts: Array<StubMount> = [];
	for (const project of projects) {
		stubMounts.push(...collectStubMountsForProject(project, rootDirectory, cacheRoot));
	}

	return stubMounts;
}

/**
 * Instrument + rojo-build the coverage place and project it to a
 * `CoverageArtifacts`, optionally baking each project's `jest.config` stub
 * into the place. The single seam the run path (`stageRun`) and the offline
 * build path (`buildCoveragePlace`) both drive, so the prepare-and-bake
 * mechanism can't drift between them. The caller owns the `bakeStubs` decision
 * (the run path skips baking for studio-cli, which injects `jest.config` at
 * runtime; the build path always bakes so a place opened by a foreign runner
 * is self-contained). Stubs must already be generated into `cacheRoot`. Baking
 * mirrors those cache stubs into the shadow tree — the source tree is clean
 * (stubs land in `cacheRoot`, not `rootDir`), so without it the coverage place
 * would build with no `jest.config` ModuleScripts.
 */
export function prepareBakedCoverage(
	config: ResolvedConfig,
	projects: Array<ResolvedProjectConfig>,
	cacheRoot: string,
	bakeStubs: boolean,
): BakedCoverage {
	const coverage = prepareCoverage(config, {
		beforeBuild: bakeStubs
			? (shadow) => syncStubsToShadowDirectory(projects, cacheRoot, shadow)
			: undefined,
		// The same globs `buildMultiRunResult` reports against, so a file is
		// probed exactly when this run would render a line for it.
		coverageInclude: resolveCoverageInclude(config, projects),
	});
	return {
		artifacts: toCoverageArtifacts(coverage, toBuildManifestProjects(projects)),
		coverage,
	};
}

/**
 * Put the run's inputs on disk: clear leftover stubs, generate this run's
 * stubs into the cache root, then instrument and build the coverage place when
 * `--coverage` is on. Runs before any backend exists, so nothing here can leak
 * one.
 */
export function stageRun(
	projects: Array<ResolvedProjectConfig>,
	rootConfig: ResolvedConfig,
	timing: TimingCollector,
): StagedRun {
	// Stubs land in `.jest-roblox/cache/` instead of the user's source tree.
	// Open-cloud builds the place from a synthesizer-produced project that
	// mounts those cache stubs via `$path` named-children; studio skips the
	// place build entirely and the plugin's Run Mode runner materializes
	// `jest.config` ModuleScripts in DataModel from the JSON configs.
	const cacheRoot = path.resolve(rootConfig.rootDir, ".jest-roblox", "cache");

	// Timed rather than merely elapsed-through: every backend does this work
	// before the dispatch window opens, so without a measurement it lands
	// outside every reported phase.
	const stagingStart = Date.now();

	// Pre-flight cleanup mirrors workspace behaviour: upgraders coming from a
	// pre-refactor version may have marker-bearing leftover stubs in their
	// source tree. The synthesizer's `assertNoSourceCollision` and the plugin's
	// runtime `FindFirstChild` check would both block the run otherwise.
	const cleaned = timing.profile("cleanLeftoverStubs", () => {
		return cleanLeftoverStubs(projects, rootConfig.rootDir);
	});
	if (cleaned.length > 0) {
		process.stderr.write(
			`jest-roblox: cleaned ${String(cleaned.length)} leftover stub(s):\n${cleaned
				.map((stubPath) => `  ${stubPath}\n`)
				.join("")}`,
		);
	}

	timing.profile("generateProjectStubs", () => {
		generateProjectStubs(projects, rootConfig.rootDir, cacheRoot);
	});

	const stubStagingMs = Date.now() - stagingStart;

	const { coverageStagingMs, ...coverage } = timing.profile("prepareCoverage", () => {
		return prepareMultiProjectCoverage(rootConfig, projects, cacheRoot);
	});
	return { cacheRoot, ...coverage, stagingMs: stubStagingMs + coverageStagingMs };
}

function collectStubMountsForProject(
	project: ResolvedProjectConfig,
	rootDirectory: string,
	cacheRoot: string,
): Array<StubMount> {
	const stubMounts: Array<StubMount> = [];
	for (const mount of project.rojoMounts) {
		const sourceMount = path.resolve(rootDirectory, mount.fsPath);
		if (hasUserAuthoredConfig(sourceMount)) {
			continue;
		}

		stubMounts.push({
			absStubPath: path.resolve(cacheRoot, mount.fsPath, STUB_FILENAME),
			dataModelPath: mount.dataModelPath,
		});
	}

	return stubMounts;
}

function prepareMultiProjectCoverage(
	rootConfig: ResolvedConfig,
	projects: Array<ResolvedProjectConfig>,
	cacheRoot: string,
): StagedCoverageRun {
	if (!rootConfig.collectCoverage) {
		return { coverageMs: 0, coverageStagingMs: 0, effectiveConfig: rootConfig };
	}

	// studio-cli drives the plugin's Run-mode runner, which materializes
	// `jest.config` ModuleScripts from the payload configs — baking here too
	// would collide ("Structural collision …"). Every other backend needs the
	// stubs baked in. `auto` never resolves to studio-cli, so the config flag is
	// the exact, probe-free signal.
	const isBakeStubs = rootConfig.backend !== "studio-cli";
	const { artifacts, coverage } = prepareBakedCoverage(
		rootConfig,
		projects,
		cacheRoot,
		isBakeStubs,
	);
	return {
		coverageArtifacts: artifacts,
		coverageMs: coverage.instrumentMs,
		coverageStagingMs: coverage.stagingMs,
		effectiveConfig: { ...rootConfig, placeFile: coverage.placeFile },
	};
}
