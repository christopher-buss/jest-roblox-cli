import type { WorkspaceRunOptions } from "../config/resolved-config.ts";
import type { RawCoverageData } from "../coverage-data/coverage-types.ts";
import { mergeRawCoverage } from "../coverage-data/merge-raw-coverage.ts";
import type { CoverageMapper } from "../coverage-report/mapper.ts";
import { toCoverageUnit } from "../results/coverage-unit.ts";
import type { CoverageUnitSettings } from "../results/coverage-unit.ts";
import { toOutputSettings } from "../results/output-settings.ts";
import type {
	OutputSettings,
	ProjectResult,
	RunCoverage,
	RunResult,
} from "../results/run-result-types.ts";
import type { BailSummary } from "../types/bail-summary-types.ts";
import { composeEntryDisplayName } from "../utils/display-name.ts";
import type { WorkspaceProjectResult } from "./coverage-attach.ts";
import type { WorkspaceRunnerOutput } from "./typecheck-pass.ts";

/** Result of a workspace run that tested nothing. */
export const EMPTY_RESULT: RunResult = {
	coverageMs: 0,
	projectResults: [],
	stagingMs: 0,
};

interface PackageEntry {
	coverageData: RawCoverageData | undefined;
	manifest: NonNullable<WorkspaceProjectResult["coverageManifest"]>;
	settings: CoverageUnitSettings;
}

/**
 * Build the final `RunResult` from the runner's output.
 * @param options - Runner output, run and CLI options, coverage folder.
 * @param options.mapCoverage - Maps raw hits onto source files.
 * @param options.output - Output of the workspace runner.
 * @param options.runOptions - Consensus-resolved run options.
 * @param options.workspaceRoot - Absolute workspace root directory.
 * @returns The workspace-run result.
 */
export function buildWorkspaceResult({
	changedFiles,
	mapCoverage,
	output: { bailedPackages, coverageMs, results, stagingMs, typecheckResult, typecheckUnits },
	runOptions,
	workspaceRoot,
}: {
	changedFiles?: ReadonlyArray<string> | undefined;
	/** Maps raw hits onto source files. */
	mapCoverage: CoverageMapper;
	/** Output of the workspace runner. */
	output: WorkspaceRunnerOutput;
	/** Consensus-resolved run options. */
	runOptions: WorkspaceRunOptions;
	/** Absolute workspace root directory. */
	workspaceRoot: string;
}): RunResult {
	const projectResults: Array<ProjectResult> = results.map((entry) => {
		return {
			displayColor: entry.displayColor,
			displayName: composeEntryDisplayName(entry.pkg, entry.displayName),
			result: entry.result,
			rootDir: entry.rootDir,
			unit: { pkg: entry.pkg, project: entry.displayName },
		};
	});
	const coverage = resolveWorkspaceCoverage({
		changedFiles,
		mapCoverage,
		runtimeResults: results,
	});

	return {
		coverage,
		...bailSummary(bailedPackages, results),
		coverageMs,
		output: resolveOutputSettings({ coverage, runOptions, workspaceRoot }),
		projectResults,
		stagingMs,
		typecheckResult,
		typecheckUnits,
	};
}

function collectPackageCoverage(
	runtimeResults: Array<WorkspaceProjectResult>,
): Map<string, PackageEntry> {
	const byPackage = new Map<string, PackageEntry>();
	for (const entry of runtimeResults) {
		if (entry.coverageManifest === undefined || entry.coverageSettings === undefined) {
			continue;
		}

		const existing = byPackage.get(entry.pkg);
		if (existing === undefined) {
			byPackage.set(entry.pkg, {
				coverageData: entry.result.coverageData,
				manifest: entry.coverageManifest,
				settings: entry.coverageSettings,
			});
			continue;
		}

		existing.coverageData = mergeRawCoverage(existing.coverageData, entry.result.coverageData);
	}

	return byPackage;
}

function resolveWorkspaceCoverage({
	changedFiles,
	mapCoverage,
	runtimeResults,
}: {
	changedFiles: ReadonlyArray<string> | undefined;
	mapCoverage: CoverageMapper;
	runtimeResults: Array<WorkspaceProjectResult>;
}): RunCoverage | undefined {
	const hasCoverage = runtimeResults.some((entry) => entry.coverageManifest !== undefined);
	if (!hasCoverage) {
		return undefined;
	}

	const perPackage = Array.from(collectPackageCoverage(runtimeResults), ([label, entry]) => {
		return toCoverageUnit({ ...entry, changedFiles, label, mapCoverage });
	});
	const notices = perPackage.flatMap(({ notice }) => (notice === undefined ? [] : [notice]));
	return {
		...(notices.length > 0 ? { notice: notices.join("\n") } : {}),
		units: perPackage.flatMap(({ units }) => units),
	};
}

function resolveOutputSettings({
	coverage,
	runOptions,
	workspaceRoot,
}: {
	coverage: RunCoverage | undefined;
	runOptions: WorkspaceRunOptions;
	workspaceRoot: string;
}): OutputSettings {
	return toOutputSettings(runOptions, {
		coverage,
		perUnitGameOutput: runOptions.workspaceGameOutput,
		perUnitOutputFile: runOptions.workspaceOutputFile,
		rootDir: workspaceRoot,
	});
}

function bailSummary(
	bailedPackages: Array<string>,
	results: Array<WorkspaceProjectResult>,
): { bail?: BailSummary } {
	if (bailedPackages.length === 0) {
		return {};
	}

	const ranPackages = new Set(results.map((entry) => entry.pkg));
	return { bail: { notRun: bailedPackages.length, ran: ranPackages.size } };
}
