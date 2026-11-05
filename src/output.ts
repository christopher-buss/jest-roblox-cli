import { DEFAULT_CONFIG, type ResolvedConfig } from "./config/schema.ts";
import type { ExecuteResult } from "./executor/executor-types.ts";
import { formatGapSummary } from "./formatters/gap-summary.ts";
import { mergeProjectResults, mergeResults } from "./output-merge.ts";
import { reportMultiRun, reportSingleRun } from "./output-report.ts";
import { writeMultiRunSinksAsync, writeSingleRunSinksAsync } from "./output-sinks.ts";
import {
	type CoveragePipeline,
	defaultCoveragePipeline,
	printFinalStatus,
} from "./reporting/coverage-report.ts";
import { defaultResultRenderer, type ResultRenderer } from "./reporting/print.ts";
import type { MultiRunResult, SingleRunResult, WorkspaceRunResult } from "./run/run-types.ts";
import type { JestResult } from "./types/jest-result-types.ts";
import { type FileSystem, nodeFileSystem } from "./utils/file-system.ts";

/** The collaborators an output run reaches the disk and the screen through. */
interface OutputDependencies {
	/** Coverage merge and report. Defaults to the real one. */
	coveragePipeline?: CoveragePipeline;
	/** Where output is written. Defaults to the real filesystem. */
	fileSystem?: FileSystem;
	/** Prints results to the screen. Defaults to the real one. */
	renderer?: ResultRenderer;
}

type ResolvedDependencies = Required<OutputDependencies>;

const NODE_OUTPUT_DEPENDENCIES: ResolvedDependencies = {
	coveragePipeline: defaultCoveragePipeline,
	fileSystem: nodeFileSystem,
	renderer: defaultResultRenderer,
};

/** Input to `outputMultiResultAsync`. */
export interface OutputMultiResultOptions {
	/** Output collaborators. Each defaults to the real one. */
	dependencies?: OutputDependencies;
	/** Multi or workspace run result to report. */
	result: MultiRunResult | WorkspaceRunResult;
	/** Root config the run used. */
	rootConfig: ResolvedConfig;
}

/** The pass/fail inputs shared by the single- and multi-run tails. */
interface RunStatus {
	isCoveragePassed: boolean;
	mergedResult: JestResult;
	snapshotWriteFailures: number | undefined;
}

/**
 * Report a multi or workspace run to the screen and output sinks.
 * @param options - Root config, result and output collaborators.
 * @returns Process exit code: 0 on pass, 1 on fail.
 */
export async function outputMultiResultAsync({
	dependencies = {},
	result,
	rootConfig,
}: OutputMultiResultOptions): Promise<number> {
	const resolved = resolveDependencies(dependencies);
	const { coverageMs, projectResults, stagingMs, typecheckResult } = result;
	const config = buildReportConfig(rootConfig, result);

	if (projectResults.length === 0) {
		return emitSingleResultAsync({
			config,
			dependencies: resolved,
			result: { coverageMs, stagingMs, typecheckResult },
		});
	}

	return emitMultiResultAsync({ config, dependencies: resolved, result });
}

function resolveDependencies(dependencies: OutputDependencies): ResolvedDependencies {
	return { ...NODE_OUTPUT_DEPENDENCIES, ...dependencies };
}

/**
 * The shared pass/fail tail: single and multi judge a run on the same four
 * inputs, so the PASS/FAIL badge and the exit code can't drift between modes.
 * Obsolete snapshots (`unchecked`) fail the run just like a snapshot the writer
 * couldn't persist.
 * @param config - Config the run used.
 * @param status - Coverage, merged result and snapshot write outcome.
 * @returns Process exit code: 0 on pass, 1 on fail.
 */
function emitFinalStatus(
	config: ResolvedConfig,
	{ isCoveragePassed, mergedResult, snapshotWriteFailures }: RunStatus,
): number {
	const areSnapshotsPersisted = (snapshotWriteFailures ?? 0) === 0;
	const areSnapshotsCurrent = (mergedResult.snapshot?.unchecked ?? 0) === 0;
	const isPassed =
		mergedResult.success && isCoveragePassed && areSnapshotsPersisted && areSnapshotsCurrent;
	if (!config.silent && config.collectCoverage) {
		printFinalStatus(isPassed);
	}

	return isPassed ? 0 : 1;
}

async function emitSingleResultAsync({
	config,
	dependencies,
	result: { coverageMs, stagingMs, typecheckResult },
}: {
	config: ResolvedConfig;
	dependencies: ResolvedDependencies;
	result: Pick<SingleRunResult, "coverageMs" | "stagingMs" | "typecheckResult">;
}): Promise<number> {
	const mergedResult = mergeResults(typecheckResult, undefined);
	const isCoveragePassed = reportSingleRun({
		config,
		dependencies,
		report: {
			agentTextFilter: undefined,
			coverageMs,
			mergedResult,
			runtimeResult: undefined,
			stagingMs,
			typecheckResult,
		},
	});

	await writeSingleRunSinksAsync({
		config,
		fileSystem: dependencies.fileSystem,
		mergedResult,
		runtimeResult: undefined,
		typecheckResult,
	});

	return emitFinalStatus(config, {
		isCoveragePassed,
		mergedResult,
		snapshotWriteFailures: undefined,
	});
}

function printGapSummary(config: ResolvedConfig, result: ExecuteResult): void {
	const summary = formatGapSummary(result.result, result.sourceMapper);
	if (summary !== undefined && !config.silent) {
		console.error(summary);
	}
}

async function emitMultiResultAsync({
	config,
	dependencies,
	result,
}: {
	config: ResolvedConfig;
	dependencies: ResolvedDependencies;
	result: MultiRunResult | WorkspaceRunResult;
}): Promise<number> {
	const { projectResults, typecheckResult } = result;
	const merged = mergeProjectResults(projectResults.map((entry) => entry.result));
	const mergedResult = mergeResults(typecheckResult, merged.result);
	const isCoveragePassed = reportMultiRun({
		config,
		dependencies,
		merged,
		result,
	});

	printGapSummary(config, merged);

	await writeMultiRunSinksAsync({
		config,
		fileSystem: dependencies.fileSystem,
		merged,
		mergedResult,
		projectResults,
		typecheckResult,
	});

	return emitFinalStatus(config, {
		isCoveragePassed,
		mergedResult,
		snapshotWriteFailures: merged.snapshotWriteFailures,
	});
}

function buildReportConfig(
	rootConfig: ResolvedConfig,
	result: MultiRunResult | WorkspaceRunResult,
): ResolvedConfig {
	if (result.mode === "workspace") {
		return {
			...DEFAULT_CONFIG,
			collectCoverage: (result.coveragePackages?.length ?? 0) > 0,
			...result.reportOptions,
		};
	}

	const config: ResolvedConfig = { ...rootConfig };
	if (result.collectCoverageFrom !== undefined) {
		config.collectCoverageFrom = result.collectCoverageFrom;
	}

	return config;
}
