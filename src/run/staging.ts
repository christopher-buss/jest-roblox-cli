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
}

/**
 * The `--coverage` half of a staged run; absent fields when coverage is off.
 */
interface StagedCoverage {
	coverageArtifacts?: CoverageArtifacts | undefined;
	effectiveConfig: ResolvedConfig;
	preCoverageMs: number;
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
): { artifacts: CoverageArtifacts; coverage: PrepareCoverageResult } {
	const coverage = prepareCoverage(
		config,
		bakeStubs
			? (shadowDirectory) => syncStubsToShadowDirectory(projects, cacheRoot, shadowDirectory)
			: undefined,
	);
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

	const coverage = timing.profile("prepareCoverage", () => {
		return prepareMultiProjectCoverage(rootConfig, projects, cacheRoot);
	});
	return { cacheRoot, ...coverage };
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
): StagedCoverage {
	if (!rootConfig.collectCoverage) {
		return { effectiveConfig: rootConfig, preCoverageMs: 0 };
	}

	// studio-cli drives the plugin's Run-mode runner, which materializes
	// `jest.config` ModuleScripts from the payload configs — baking here too
	// would collide ("Structural collision …"). Every other backend needs the
	// stubs baked in. `auto` never resolves to studio-cli, so the config flag is
	// the exact, probe-free signal.
	const isBakeStubs = rootConfig.backend !== "studio-cli";
	const start = Date.now();
	const { artifacts, coverage } = prepareBakedCoverage(
		rootConfig,
		projects,
		cacheRoot,
		isBakeStubs,
	);
	return {
		coverageArtifacts: artifacts,
		effectiveConfig: { ...rootConfig, placeFile: coverage.placeFile },
		preCoverageMs: Date.now() - start,
	};
}
