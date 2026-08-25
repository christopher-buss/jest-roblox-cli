import { collectProjectRoots } from "../config/filter-projects-by-files.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import {
	type CoverageDisplayPredicate,
	projectRootFilter,
	sourceTwinFilter,
} from "../coverage-pipeline/agent-table-filter.ts";
import type { AttributionResult } from "../coverage-pipeline/attribution.ts";
import { mergeAttribution } from "../coverage-pipeline/attribution.ts";
import { resolveCoverageInclude } from "../coverage-pipeline/derive-coverage-from.ts";
import { mergeRawCoverage } from "../coverage-pipeline/merge-raw-coverage.ts";
import type { RawCoverageData } from "../coverage-pipeline/types.ts";
import { combineSourceMappers, type SourceMapper } from "../source-mapper/index.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import type { ExecutionOutcome } from "./execution.ts";
import type { StagedRun } from "./staging.ts";
import type { RunDiscovery, TestPlan } from "./test-plan.ts";
import type { MultiProjectMerged, MultiRunResult, ProjectResult, RunOptions } from "./types.ts";

export interface MultiRunResultInput {
	cli: RunOptions["cli"];
	discovery: RunDiscovery;
	outcome: ExecutionOutcome;
	plan: TestPlan;
	staged: StagedRun;
}

/**
 * Project a finished run onto the `MultiRunResult` the report layer consumes:
 * the coverage source universe, the display-only agent-table narrowing, and
 * the per-project results merged into one coverage/attribution/source-mapper
 * triple.
 */
export function buildMultiRunResult({
	cli,
	discovery,
	outcome,
	plan,
	staged,
}: MultiRunResultInput): MultiRunResult {
	const { projects, rootConfig } = discovery;
	const collectCoverageFrom = resolveCoverageInclude(rootConfig, projects);

	return {
		collectCoverageFrom,
		coverageArtifacts: staged.coverageArtifacts,
		coverageDisplayFilter: buildMultiDisplayFilter({
			cliFiles: cli.files,
			matchedRuntimeFiles: plan.matchedRuntimeFiles,
			projectNames: cli.project,
			projects,
			rootDir: rootConfig.rootDir,
			testPathPattern: rootConfig.testPathPattern,
		}),
		coverageMs: staged.coverageMs,
		merged: mergeForMultiResult(outcome.projectResults),
		mode: "multi",
		projectResults: outcome.projectResults,
		stagingMs: staged.stagingMs + outcome.placeBuildMs,
		typecheckResult: outcome.typecheck.result,
	};
}

// Builds the agent text-table narrowing for a filtered multi run. Files named
// directly (positionals) win as source twins; a `--testPathPattern` twins the
// matched runtime files; a bare `--project` scopes the table to the selected
// projects' source roots (so the project's untested files still report 0%). A
// full run (none of these) returns undefined — the table keeps the full
// universe. Display-only: never reaches thresholds, totals, or lcov/html/json.
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
	// Positionals name the files directly; twin the raw CLI args (not the
	// post-discovery set) so the table reflects exactly what the user typed.
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
	// Projects whose `include` is a bare glob (no static directory prefix)
	// yield no roots, so there is no containment boundary to scope by. Fall
	// back to the full universe rather than an empty table — the user passed
	// `--project`, so showing every file beats showing nothing.
	return roots.length > 0 ? projectRootFilter(roots) : undefined;
}

function mergeForMultiResult(projectResults: Array<ProjectResult>): MultiProjectMerged {
	let mergedCoverage: RawCoverageData | undefined;
	let mergedAttribution: AttributionResult | undefined;
	const mappers: Array<SourceMapper> = [];

	for (const { result } of projectResults) {
		if (result.coverageData !== undefined) {
			mergedCoverage = mergeRawCoverage(mergedCoverage, result.coverageData);
		}

		if (result.attribution !== undefined) {
			mergedAttribution =
				mergedAttribution === undefined
					? result.attribution
					: mergeAttribution(mergedAttribution, result.attribution);
		}

		if (result.sourceMapper !== undefined) {
			mappers.push(result.sourceMapper);
		}
	}

	const merged: MultiProjectMerged = {};
	if (mergedCoverage !== undefined) {
		merged.coverageData = mergedCoverage;
	}

	if (mergedAttribution !== undefined) {
		merged.attribution = mergedAttribution;
	}

	if (mappers.length > 0) {
		merged.sourceMapper = combineSourceMappers(mappers);
	}

	return merged;
}
