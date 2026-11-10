import * as path from "node:path";

import { pickCoverageSettings } from "../config/coverage-settings.ts";
import { collectProjectRoots } from "../config/filter-projects-by-files.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import type { CliOptions, ResolvedConfig } from "../config/resolved-config.ts";
import type { RawCoverageData } from "../coverage-data/coverage-types.ts";
import type { CoverageManifest } from "../coverage-data/manifest.ts";
import { mergeRawCoverage } from "../coverage-data/merge-raw-coverage.ts";
import {
	type CoverageDisplayPredicate,
	projectRootFilter,
	sourceTwinFilter,
} from "../coverage-report/agent-table-filter.ts";
import { toCoverageUnit } from "../results/coverage-unit.ts";
import { toOutputSettings } from "../results/output-settings.ts";
import type {
	OutputSettings,
	ProjectResult,
	RunCoverage,
	RunResult,
} from "../results/run-result-types.ts";
import type { TypecheckPassOutcome } from "../typecheck/typecheck-groups.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import type { RunDiscovery, TestPlan } from "./run-plan.ts";
import type { RunSeams } from "./seams.ts";
import type { StagedRun } from "./staging.ts";

/** Inputs of {@link buildMultiRunResult}. */
export interface MultiRunResultInput {
	/** Parsed command-line options. */
	cli: CliOptions;
	/** Discovered projects and root config. */
	discovery: RunDiscovery;
	/** Outcome of the executed run. */
	outcome: ExecutionOutcome;
	/** Planned test files of the run. */
	plan: TestPlan;
	/** Reads and maps the coverage. */
	seams: CoverageSeams;
	/** Staging products and timings. */
	staged: StagedRun;
}

interface ExecutionOutcome {
	placeBuildMs: number;
	projectResults: Array<ProjectResult>;
	typecheck: TypecheckPassOutcome;
}

type CoverageSeams = Pick<RunSeams, "mapCoverage">;

/**
 * Project a finished run onto the `RunResult` the output layer consumes.
 * @param options - CLI options, discovery, outcome, plan, seams and staging.
 * @returns The result the output layer reports.
 */
export function buildMultiRunResult({
	cli,
	discovery,
	outcome,
	plan,
	seams,
	staged,
}: MultiRunResultInput): RunResult {
	const { projects, rootConfig } = discovery;
	const coverage = resolveProjectCoverage(
		coverageInputs({ discovery, outcome, rootConfig, seams, staged }),
	);

	return {
		affected: plan.affected,
		coverage,
		coverageArtifacts: staged.coverageArtifacts,
		coverageChangedFiles: discovery.partialRun?.files,
		coverageDisplayFilter: buildMultiDisplayFilter({
			cliFiles: cli.files,
			matchedRuntimeFiles: plan.matchedRuntimeFiles,
			projectNames: cli.project,
			projects,
			rootDir: rootConfig.rootDir,
			testPathPattern: rootConfig.testPathPattern,
		}),
		coverageMs: staged.coverageMs,
		output: resolveProjectOutput(rootConfig, coverage),
		projectResults: outcome.projectResults,
		stagingMs: staged.stagingMs + outcome.placeBuildMs,
		typecheckResult: outcome.typecheck.result,
	};
}

/**
 * The output settings of a single or multi run: the root config's.
 * @param rootConfig - Config with the CLI options merged in.
 * @param coverage - The run's coverage report, if any.
 * @returns The output settings.
 */
function resolveProjectOutput(
	rootConfig: ResolvedConfig,
	coverage: RunCoverage | undefined,
): OutputSettings {
	return toOutputSettings(rootConfig, {
		coverage,
		perUnitGameOutput: false,
		perUnitOutputFile: false,
		rootDir: rootConfig.rootDir,
	});
}

/**
 * Map a run's raw hit counts through the staged coverage manifest.
 * @param options - Coverage globs, raw hits, manifest, root config and seams.
 * @returns The mapped coverage, or nothing when coverage is off.
 */
function resolveProjectCoverage({
	changedFiles,
	collectCoverageFrom,
	coverageData,
	manifest,
	rootConfig,
	seams,
}: {
	changedFiles: ReadonlyArray<string> | undefined;
	collectCoverageFrom: Array<string> | undefined;
	coverageData: RawCoverageData | undefined;
	manifest: CoverageManifest | undefined;
	rootConfig: ResolvedConfig;
	seams: CoverageSeams;
}): RunCoverage | undefined {
	if (!rootConfig.collectCoverage) {
		return undefined;
	}

	return toCoverageUnit({
		changedFiles,
		coverageData,
		manifest,
		mapCoverage: seams.mapCoverage,
		settings: {
			collectCoverageFrom,
			coverageDirectory: path.resolve(rootConfig.rootDir, rootConfig.coverageDirectory),
			coveragePathIgnorePatterns: rootConfig.coveragePathIgnorePatterns,
			coverageReporters: rootConfig.coverageReporters,
			coverageThreshold: rootConfig.coverageThreshold,
			rootDir: rootConfig.rootDir,
		},
	});
}

function buildMultiDisplayFilter({
	cliFiles,
	matchedRuntimeFiles,
	projectNames,
	projects,
	rootDir,
	testPathPattern,
}: {
	cliFiles: Array<string> | undefined;
	matchedRuntimeFiles: Array<string>;
	projectNames: Array<string> | undefined;
	projects: Array<ResolvedProjectConfig>;
	rootDir: string;
	testPathPattern: string | undefined;
}): CoverageDisplayPredicate | undefined {
	if (cliFiles !== undefined && cliFiles.length > 0) {
		return sourceTwinFilter(cliFiles, rootDir);
	}

	if (testPathPattern !== undefined) {
		return sourceTwinFilter(matchedRuntimeFiles, rootDir);
	}

	if (projectNames === undefined) {
		return undefined;
	}

	const posixRootDirectory = normalizeWindowsPath(rootDir);
	const roots = projects.flatMap((project) => collectProjectRoots(project, posixRootDirectory));
	return roots.length > 0 ? projectRootFilter(roots) : undefined;
}

function coverageInputs({
	discovery,
	outcome,
	rootConfig,
	seams,
	staged,
}: Pick<MultiRunResultInput, "discovery" | "outcome" | "seams" | "staged"> & {
	rootConfig: ResolvedConfig;
}): Parameters<typeof resolveProjectCoverage>[0] {
	return {
		changedFiles: discovery.partialRun?.files,
		collectCoverageFrom: pickCoverageSettings(rootConfig).collectCoverageFrom,
		coverageData: outcome.projectResults.reduce<RawCoverageData | undefined>(
			(merged, entry) => mergeRawCoverage(merged, entry.result.coverageData),
			undefined,
		),
		manifest: staged.coverageManifest,
		rootConfig,
		seams,
	};
}
