import type { ResolvedProjectConfig } from "../config/projects.ts";
import type { ResolvedConfig } from "../config/resolved-config.ts";
import type { BuildManifestProject, CoverageArtifacts } from "../coverage-data/build-manifest.ts";
import { emitBuildManifest } from "../coverage-data/build-manifest.ts";
import { resolveCoverageLayout } from "../coverage-data/coverage-layout.ts";
import type { CoverageManifest } from "../coverage-data/manifest.ts";
import { toCoverageArtifacts } from "../shadow/prepare.ts";
import { stageProjectStubs, stubCacheRoot } from "../staging/stage-stubs.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import { PREPARE_COVERAGE_SPAN } from "../timing/span-names.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { buildProjectCoveragePlan } from "./coverage-plan.ts";
import type { RunSeams } from "./seams.ts";

/** Run inputs staged on disk before a backend exists. */
export interface StagedRun extends StagedCoverage {
	/** Directory the generated `jest.config` stubs are written to. */
	cacheRoot: string;
	/** Host time spent putting this run's inputs on disk. */
	stagingMs: number;
}

/** Inputs of {@link stageRunAsync}. */
export interface StageRunOptions {
	/** File system to stage on. */
	fileSystem: FileSystem;
	/** Resolved projects of the run. */
	projects: Array<ResolvedProjectConfig>;
	/** Root config of the run. */
	rootConfig: ResolvedConfig;
	/** Seams coverage preparation reaches outside the run through. */
	seams: CoverageSeams;
	/** Profiler of the run. */
	timing: TimingCollector;
}

interface StagedCoverage {
	coverageArtifacts?: CoverageArtifacts | undefined;
	coverageManifest?: CoverageManifest | undefined;
	coverageMs: number;
	effectiveConfig: ResolvedConfig;
}

type CoverageSeams = Pick<RunSeams, "childProcess" | "prepareCoverage" | "tsconfigReader">;

/**
 * Put the run's inputs on disk before any backend exists.
 * @param options - Backend, projects, config, seams and profiler.
 * @param options.fileSystem - File system to stage on.
 * @param options.projects - Resolved projects of the run.
 * @param options.rootConfig - Config whose `rootDir` holds the cache.
 * @param options.seams - Seams the run reaches outside itself through.
 * @param options.timing - Profiler of the run.
 * @returns The staged run with its staging and coverage timings.
 */
export async function stageRunAsync({
	fileSystem,
	projects,
	rootConfig,
	seams,
	timing,
}: StageRunOptions): Promise<StagedRun> {
	const cacheRoot = stubCacheRoot(rootConfig.rootDir);
	const stubStagingMs = stageProjectStubs({
		fileSystem,
		packages: [{ cacheRoot, projects, rootDirectory: rootConfig.rootDir }],
		timing,
	});

	if (!rootConfig.collectCoverage) {
		return { cacheRoot, coverageMs: 0, effectiveConfig: rootConfig, stagingMs: stubStagingMs };
	}

	const { coverageStagingMs, ...coverage } = await timing.profileAsync(
		PREPARE_COVERAGE_SPAN,
		async () => {
			return prepareCoverageAsync({
				cacheRoot,
				fileSystem,
				projects,
				rootConfig,
				seams,
				timing,
			});
		},
	);
	return { cacheRoot, ...coverage, stagingMs: stubStagingMs + coverageStagingMs };
}

function toBuildManifestProjects(
	projects: Array<ResolvedProjectConfig>,
): Array<BuildManifestProject> {
	return projects.flatMap((project) => {
		return project.projects.map((projectDataModelPath) => {
			let manifestProject: BuildManifestProject = {
				displayName: project.displayName,
				projectDataModelPath,
				setupFiles: project.config.setupFiles ?? [],
				setupFilesAfterEnv: project.config.setupFilesAfterEnv ?? [],
				testMatch: project.testMatch,
			};
			if (project.config.jestPath !== undefined) {
				manifestProject = {
					...manifestProject,
					jestDataModelPath: project.config.jestPath,
				};
			}

			return manifestProject;
		});
	});
}

async function prepareCoverageAsync({
	cacheRoot,
	fileSystem,
	projects,
	rootConfig,
	seams,
	timing,
}: StageRunOptions & { cacheRoot: string }): Promise<
	StagedCoverage & { coverageStagingMs: number }
> {
	const coverage = await seams.prepareCoverage(rootConfig, {
		...buildProjectCoveragePlan({ cacheRoot, fileSystem, projects, rootConfig }),
		childProcess: seams.childProcess,
		fileSystem,
		timing,
		tsconfigReader: seams.tsconfigReader,
	});
	const artifacts = toCoverageArtifacts(coverage, toBuildManifestProjects(projects));
	if (artifacts.rebuilt) {
		const filePath = resolveCoverageLayout(rootConfig.rootDir).buildManifestPath;
		emitBuildManifest({ artifacts, filePath, fileSystem });
	}

	return {
		coverageArtifacts: artifacts,
		coverageManifest: coverage.manifest,
		coverageMs: coverage.instrumentMs,
		coverageStagingMs: coverage.stagingMs,
		effectiveConfig: { ...rootConfig, placeFile: coverage.placeFile },
	};
}
