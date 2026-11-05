import assert from "node:assert";

import type { CliOptions, WorkspaceRunOptions } from "../config/schema.ts";
import type { RawCoverageData } from "../coverage-pipeline/coverage-types.ts";
import { mergeRawCoverage } from "../coverage-pipeline/merge-raw-coverage.ts";
import type {
	aggregateWorkspaceCoverage,
	WorkspacePackageUniverse,
} from "../coverage-pipeline/workspace-aggregate.ts";
import type { BailSummary } from "../formatters/shared.ts";
import { composeEntryDisplayName } from "../utils/display-name.ts";
import type { WorkspaceProjectResult, WorkspaceRunnerOutput } from "../workspace-runner.ts";
import type { PackageCoverageSettings } from "../workspace/coverage-attach.ts";
import type {
	ProjectResult,
	WorkspacePackageCoverageGate,
	WorkspaceReportOptions,
	WorkspaceRunResult,
} from "./run-types.ts";

/** Result of a workspace run that tested nothing. */
export const EMPTY_RESULT: WorkspaceRunResult = {
	coverageMs: 0,
	merged: {},
	mode: "workspace",
	projectResults: [],
	stagingMs: 0,
};

/** One package's accumulated coverage inputs, merged across its projects. */
interface PackageEntry {
	coverageData: RawCoverageData | undefined;
	ignorePatterns: Array<string> | undefined;
	includePatterns: Array<string> | undefined;
	manifest: NonNullable<WorkspaceProjectResult["coverageManifest"]>;
	pkg: string;
	rootDir: string;
}

interface AggregatePerPackageCoverageResult {
	settingsByPackage: Map<string, PackageCoverageSettings>;
	universes: Array<WorkspacePackageUniverse>;
}

/**
 * Builds the final `WorkspaceRunResult` from the runner's output: the runtime
 * project results plus (when present) the merged Type Test result.
 *
 * @param options - Runner output, run options, CLI options and the coverage folder.
 * @param options.aggregateCoverage - Folds per-package coverage into reports.
 * @param options.cli - Parsed command-line options.
 * @param options.output - Output of the workspace runner.
 * @param options.runOptions - Consensus-resolved run options.
 * @param options.workspaceRoot - Absolute workspace root directory.
 * @returns The workspace-run result, or {@link EMPTY_RESULT} when nothing ran.
 */
export function buildWorkspaceResult({
	aggregateCoverage,
	cli,
	output: { bailedPackages, coverageMs, results, stagingMs, typecheckResult },
	runOptions,
	workspaceRoot,
}: {
	/** Folds per-package coverage into reports. */
	aggregateCoverage: typeof aggregateWorkspaceCoverage;
	/** Parsed command-line options. */
	cli: CliOptions;
	/** Output of the workspace runner. */
	output: WorkspaceRunnerOutput;
	/** Consensus-resolved run options. */
	runOptions: WorkspaceRunOptions;
	/** Absolute workspace root directory. */
	workspaceRoot: string;
}): WorkspaceRunResult {
	// A run with neither runtime results nor a Type Test result tested nothing
	// (no pending specs, typecheck off). `--typecheckOnly` lands here with zero
	// runtime results but a populated `typecheckResult`, so it must not collapse
	// to EMPTY_RESULT.
	if (typecheckResult === undefined && results.length === 0) {
		return EMPTY_RESULT;
	}

	const projectResults: Array<ProjectResult> = results.map((entry) => {
		return {
			displayName: composeEntryDisplayName(entry.pkg, entry.displayName),
			result: entry.result,
		};
	});

	return {
		...resolveWorkspaceCoverage(results, aggregateCoverage),
		...bailSummary(bailedPackages, results),
		// A typecheck-only run stages nothing, so the runner reports neither.
		coverageMs: coverageMs ?? 0,
		merged: {},
		mode: "workspace",
		projectResults,
		reportOptions: resolveReportOptions({ cli, runOptions, workspaceRoot }),
		stagingMs: stagingMs ?? 0,
		typecheckResult,
		...resolvedSinkPaths(runOptions),
	};
}

function aggregatePerPackageCoverage(
	runtimeResults: Array<WorkspaceProjectResult>,
	aggregateCoverage: typeof aggregateWorkspaceCoverage,
): AggregatePerPackageCoverageResult {
	// A package with multiple projects emits one entry per project. Each
	// project runs Jest with its own `_G.__jest_roblox_cov` reset, so the
	// per-entry `coverageData` captures DIFFERENT hits across projects. We
	// must additively merge those maps per pkg (not drop them) before passing
	// one entry per pkg into the mapper — otherwise multi-project packages
	// silently lose coverage from all but the first project.
	const byPackage = new Map<string, PackageEntry>();
	const settingsByPackage = new Map<string, PackageCoverageSettings>();

	for (const entry of runtimeResults) {
		if (entry.coverageManifest === undefined || entry.coverageSettings === undefined) {
			continue;
		}

		const existing = byPackage.get(entry.pkg);
		if (existing === undefined) {
			byPackage.set(entry.pkg, {
				coverageData: entry.result.coverageData,
				ignorePatterns: entry.coverageSettings.coveragePathIgnorePatterns,
				includePatterns: entry.coverageSettings.collectCoverageFrom,
				manifest: entry.coverageManifest,
				pkg: entry.pkg,
				rootDir: entry.coverageSettings.rootDir,
			});
			settingsByPackage.set(entry.pkg, entry.coverageSettings);
			continue;
		}

		existing.coverageData = mergeRawCoverage(existing.coverageData, entry.result.coverageData);
	}

	return {
		settingsByPackage,
		universes: aggregateCoverage([...byPackage.values()]),
	};
}

/**
 * Drive coverage off per-package manifests, not the workspace-level
 * `collectCoverage`. A package that opted into coverage via its own jest.config
 * carries a `coverageManifest`; aggregating regardless of workspace config
 * keeps that report from being dropped. Each gate carries the package's own
 * reporter settings so the report layer emits one report per package, into that
 * package's own directory, from that package's own config.
 *
 * @param runtimeResults - Per-project runtime results.
 * @param aggregateCoverage - Folds per-package coverage into reports.
 * @returns The per-package coverage gates, or nothing when no package has coverage.
 */
function resolveWorkspaceCoverage(
	runtimeResults: Array<WorkspaceProjectResult>,
	aggregateCoverage: typeof aggregateWorkspaceCoverage,
): Pick<WorkspaceRunResult, "coveragePackages"> {
	const hasCoverage = runtimeResults.some((entry) => entry.coverageManifest !== undefined);
	if (!hasCoverage) {
		return {};
	}

	const { settingsByPackage, universes } = aggregatePerPackageCoverage(
		runtimeResults,
		aggregateCoverage,
	);
	const coveragePackages = universes.map(({ pkg, universe }) => {
		// `universes` is derived from the same map `settingsByPackage` is keyed
		// by, so every entry has settings.
		const settings = settingsByPackage.get(pkg);
		assert(settings !== undefined);

		let coveragePackage: WorkspacePackageCoverageGate = {
			coverageDirectory: settings.coverageDirectory,
			coverageReporters: settings.coverageReporters,
			pkg,
			universe,
		};
		if (settings.coverageThreshold !== undefined) {
			coveragePackage = {
				...coveragePackage,
				coverageThreshold: settings.coverageThreshold,
			};
		}

		return coveragePackage;
	});

	return { coveragePackages };
}

/**
 * Surface the consensus-resolved aggregate sink paths the runner wrote so
 * formatters point "View …" hints at files that actually exist.
 *
 * @param runOptions - Consensus-resolved run options.
 * @returns The Game Output and output file paths.
 */
function resolvedSinkPaths(
	runOptions: WorkspaceRunOptions,
): Pick<WorkspaceRunResult, "gameOutput" | "outputFile"> {
	return {
		gameOutput: runOptions.gameOutput,
		outputFile: runOptions.outputFile,
	};
}

/**
 * The output layer has no config to read in workspace mode, so hand it the
 * values this run resolved: the consensus knobs for the render, the workspace
 * root the formatters report paths against, and `verbose` straight off the CLI
 * (it is a flag, never a per-package config value — the run header and the
 * streaming sink read it the same way).
 *
 * @param options - CLI options, run options and workspace root.
 * @param options.cli - Parsed command-line options; supplies `verbose`.
 * @param options.runOptions - Consensus-resolved run options.
 * @param options.workspaceRoot - Directory the formatters report paths against.
 * @returns The render settings of the output layer.
 */
function resolveReportOptions({
	cli,
	runOptions,
	workspaceRoot,
}: {
	cli: CliOptions;
	runOptions: WorkspaceRunOptions;
	workspaceRoot: string;
}): WorkspaceReportOptions {
	return {
		color: runOptions.color,
		formatters: runOptions.formatters,
		rootDir: workspaceRoot,
		silent: runOptions.silent,
		verbose: cli.verbose === true,
	};
}

/**
 * Counted in packages, not project rows: one package can own several projects,
 * and "after 3 packages" reading as 3 when only one package ran would misreport
 * how far the run got.
 *
 * @param bailedPackages - Packages a `--bail` run did not run.
 * @param results - Per-project runtime results.
 * @returns The bail summary, or nothing when the run did not bail.
 */
function bailSummary(
	bailedPackages: Array<string> | undefined,
	results: Array<WorkspaceProjectResult>,
): { bail?: BailSummary } {
	if (bailedPackages === undefined || bailedPackages.length === 0) {
		return {};
	}

	const ranPackages = new Set(results.map((entry) => entry.pkg));
	return { bail: { notRun: bailedPackages.length, ran: ranPackages.size } };
}
