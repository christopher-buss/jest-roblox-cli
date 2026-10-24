import assert from "node:assert";
import process from "node:process";

import { DEFAULT_CONFIG, type ResolvedConfig } from "./config/schema.ts";
import { mergeRawCoverage } from "./coverage-pipeline/merge-raw-coverage.ts";
import type { RawCoverageData } from "./coverage-pipeline/types.ts";
import type { ExecuteResult } from "./executor/types.ts";
import { mergeSnapshotSummaries } from "./formatters/formatter.ts";
import { formatGapSummary } from "./formatters/gap-summary.ts";
import {
	formatAnnotations,
	formatJobSummary,
	resolveGitHubActionsOptions,
} from "./formatters/github-actions.ts";
import { writeJsonFileAsync } from "./formatters/json.ts";
import { findFormatterOptions, usesAgentFormatter } from "./formatters/utils.ts";
import {
	type CoveragePipeline,
	defaultCoveragePipeline,
	extractCoverageDisplayFilter,
	extractCoveragePackages,
	printFinalStatus,
	processCoverage,
} from "./reporting/coverage-report.ts";
import {
	defaultResultRenderer,
	type MultiOutputContext,
	printMultiResults,
	printSingleResults,
	type ResultRenderer,
} from "./reporting/print.ts";
import { mergeJestTotals } from "./results/merge.ts";
import type {
	MultiRunResult,
	ProjectResult,
	SingleRunResult,
	WorkspaceRunResult,
} from "./run/types.ts";
import { combineSourceMappers, type SourceMapper } from "./source-mapper/index.ts";
import type { PackageGameOutput } from "./types/game-output.ts";
import type { JestResult } from "./types/jest-result.ts";
import type { TimingResult } from "./types/timing.ts";
import type { FileSystem } from "./utils/file-system.ts";
import { nodeFileSystem } from "./utils/file-system.ts";
import {
	buildBatchGameOutput,
	buildGroupedGameOutput,
	countGroupedEntries,
	formatGameOutputNotice,
	parseGameOutput,
	writeGameOutput,
	writeGroupedGameOutput,
} from "./utils/game-output.ts";

/** The collaborators an output run reaches the disk and the screen through. */
export interface OutputDependencies {
	coveragePipeline?: CoveragePipeline;
	fileSystem?: FileSystem;
	renderer?: ResultRenderer;
}

type ResolvedDependencies = Required<OutputDependencies>;

const NODE_OUTPUT_DEPENDENCIES: ResolvedDependencies = {
	coveragePipeline: defaultCoveragePipeline,
	fileSystem: nodeFileSystem,
	renderer: defaultResultRenderer,
};

export interface OutputSingleResultOptions {
	config: ResolvedConfig;
	dependencies?: OutputDependencies;
	result: SingleRunResult;
}

export interface OutputMultiResultOptions {
	dependencies?: OutputDependencies;
	result: MultiRunResult | WorkspaceRunResult;
	rootConfig: ResolvedConfig;
}

/**
 * Per-project fields the shared Jest merge doesn't know about — the timing
 * splits, the snapshot-write tally, and the raw coverage fold.
 */
interface ProjectExtras {
	coverageData: RawCoverageData | undefined;
	setupMs: number;
	snapshotWriteFailures: number;
	testsMs: number;
}

interface MultiRunSinks {
	hintsShown: boolean;
	merged: ExecuteResult;
	projectResults: Array<ProjectResult>;
	typecheckResult: JestResult | undefined;
}

/** The pass/fail inputs shared by the single- and multi-run tails. */
interface RunStatus {
	isCoveragePassed: boolean;
	mergedResult: JestResult;
	snapshotWriteFailures: number | undefined;
}

/** What one single-mode run prints, and what its coverage was filtered by. */
interface SingleRunReport extends Pick<
	SingleRunResult,
	"coverageMs" | "runtimeResult" | "stagingMs" | "typecheckResult"
> {
	agentTextFilter: SingleRunResult["coverageDisplayFilter"];
	mergedResult: JestResult;
}

interface WriteGameOutputIfConfiguredOptions {
	config: ResolvedConfig;
	fileSystem: FileSystem;
	gameOutput: string | undefined;
	hintsShown?: boolean;
}

interface RunGitHubActionsFormatterOptions {
	config: ResolvedConfig;
	fileSystem: FileSystem;
	result: JestResult;
	sourceMapper: SourceMapper | undefined;
}

interface WriteAggregatedGameOutputOptions {
	config: ResolvedConfig;
	fileSystem: FileSystem;
	hintsShown?: boolean;
	projectResults: Array<ProjectResult>;
}

interface ToMultiOutputContextOptions {
	config: ResolvedConfig;
	merged: ExecuteResult;
	renderer: ResultRenderer;
	result: MultiRunResult | WorkspaceRunResult;
}

// Combines a Type Test result with the runtime result into one aggregate (counts
// summed, testResults concatenated, success AND-ed). Shared with the workspace
// runner, which owns the workspace `outputFile` sink.
export function mergeResults(
	typecheck: JestResult | undefined,
	runtime: JestResult | undefined,
): JestResult {
	if (typecheck !== undefined && runtime !== undefined) {
		return {
			numFailedTests: typecheck.numFailedTests + runtime.numFailedTests,
			numPassedTests: typecheck.numPassedTests + runtime.numPassedTests,
			numPendingTests: typecheck.numPendingTests + runtime.numPendingTests,
			numTodoTests: (typecheck.numTodoTests ?? 0) + (runtime.numTodoTests ?? 0),
			numTotalTests: typecheck.numTotalTests + runtime.numTotalTests,
			snapshot: runtime.snapshot,
			startTime: Math.min(typecheck.startTime, runtime.startTime),
			success: typecheck.success && runtime.success,
			testResults: [...typecheck.testResults, ...runtime.testResults],
		};
	}

	const result = typecheck ?? runtime;
	assert(result !== undefined, "mergeResults requires at least one result");
	return result;
}

// The single owner of the merged result-file (`outputFile`) sink across every
// mode — single, multi, and workspace. Gates on the resolved sink path (the one
// seam where `config.outputFile` vs the workspace consensus path is decided by
// the caller) and serializes the shared `mergeResults` output. Routing both
// sides through `mergeResults` here means a new result dimension lands in the
// file for every mode by a one-line change to that merge, with no second writer
// to keep in sync.
export async function writeResultFileAsync({
	fileSystem = nodeFileSystem,
	outputFile,
	runtime,
	typecheck,
}: {
	fileSystem?: FileSystem | undefined;
	outputFile: string | undefined;
	runtime: JestResult | undefined;
	typecheck: JestResult | undefined;
}): Promise<void> {
	if (outputFile === undefined) {
		return;
	}

	await writeJsonFileAsync({
		filePath: outputFile,
		fileSystem,
		result: mergeResults(typecheck, runtime),
	});
}

export async function outputSingleResultAsync({
	config,
	dependencies = {},
	result,
}: OutputSingleResultOptions): Promise<number> {
	return emitSingleResultAsync({
		config,
		dependencies: resolveDependencies(dependencies),
		result,
	});
}

export function mergeProjectResults(results: Array<ExecuteResult>): ExecuteResult {
	const [firstResult] = results;
	assert(firstResult !== undefined, "mergeProjectResults requires at least one result");

	if (results.length === 1) {
		return firstResult;
	}

	const jestResults = results.map((entry) => entry.result);
	const extras = mergeProjectExtras(results);
	const snapshots = jestResults
		.map((result) => result.snapshot)
		.filter((snapshot) => snapshot !== undefined);
	const sourceMappers = results
		.map((entry) => entry.sourceMapper)
		.filter((sourceMapper) => sourceMapper !== undefined);
	const totals = mergeJestTotals(jestResults);

	return {
		coverageData: extras.coverageData,
		exitCode: totals.success && extras.snapshotWriteFailures === 0 ? 0 : 1,
		output: "",
		result: { ...totals, snapshot: mergeSnapshotSummaries(snapshots) },
		snapshotWriteFailures:
			extras.snapshotWriteFailures > 0 ? extras.snapshotWriteFailures : undefined,
		sourceMapper: combineSourceMappers(sourceMappers),
		timing: mergeProjectTiming({ extras, firstResult, results }),
	};
}

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
			result: { coverageMs, mode: "single", stagingMs, typecheckResult },
		});
	}

	return emitMultiResultAsync({ config, dependencies: resolved, result });
}

function resolveDependencies(dependencies: OutputDependencies): ResolvedDependencies {
	return { ...NODE_OUTPUT_DEPENDENCIES, ...dependencies };
}

function printGapSummary(config: ResolvedConfig, result: ExecuteResult | undefined): void {
	if (result === undefined) {
		return;
	}

	const summary = formatGapSummary(result.result, result.sourceMapper);
	if (summary !== undefined && !config.silent) {
		console.error(summary);
	}
}

// In agent mode the run summary must survive an agent trimming the tail of the
// output. The coverage report would otherwise print below the summary and bury
// it, so when coverage is enabled the summary is deferred to print *after* the
// report. Every other mode keeps the human reading order: results first,
// coverage last. Single and multi both route through here so the ordering
// can't drift between modes.
//
// `coverageEnabled` only decides *when* the summary prints relative to coverage;
// it does not gate the coverage call itself. `runCoverage` (`processCoverage`)
// already no-ops when coverage is off, so it is always invoked here.
function emitResultsAndCoverage({
	config,
	coverageEnabled,
	printResults,
	runCoverage,
}: {
	config: ResolvedConfig;
	coverageEnabled: boolean;
	printResults: () => void;
	runCoverage: () => boolean;
}): boolean {
	const shouldDeferResults =
		coverageEnabled && usesAgentFormatter(config.formatters, config.verbose);

	if (!shouldDeferResults) {
		printResults();
	}

	try {
		return runCoverage();
	} finally {
		// `finally` so the deferred summary still reaches stdout even when
		// coverage mapping throws (e.g. a malformed coverage map) — losing it
		// would regress the unconditional "results print" of the non-agent path.
		if (shouldDeferResults) {
			printResults();
		}
	}
}

/** Prints the run and reports whether its coverage cleared the thresholds. */
function reportSingleRun({
	config,
	dependencies: { coveragePipeline, renderer },
	report: {
		agentTextFilter,
		coverageMs,
		mergedResult,
		runtimeResult,
		stagingMs,
		typecheckResult,
	},
}: {
	config: ResolvedConfig;
	dependencies: ResolvedDependencies;
	report: SingleRunReport;
}): boolean {
	return emitResultsAndCoverage({
		config,
		coverageEnabled: config.collectCoverage,
		printResults: () => {
			printSingleResults(config, {
				coverageMs,
				mergedResult,
				renderer,
				runtimeResult,
				stagingMs,
				typecheckResult,
			});
		},
		runCoverage: () => {
			return processCoverage({
				agentTextFilter,
				config,
				coverageData: runtimeResult?.coverageData,
				pipeline: coveragePipeline,
			});
		},
	});
}

function writeGameOutputIfConfigured({
	config,
	fileSystem,
	gameOutput,
	hintsShown,
}: WriteGameOutputIfConfiguredOptions): void {
	if (config.gameOutput === undefined) {
		return;
	}

	const entries = parseGameOutput(gameOutput);
	writeGameOutput({ entries, filePath: config.gameOutput, fileSystem });

	if (hintsShown !== true && !config.silent) {
		const notice = formatGameOutputNotice(config.gameOutput, entries.length);
		if (notice) {
			console.error(notice);
		}
	}
}

function runGitHubActionsFormatter({
	config,
	fileSystem,
	result,
	sourceMapper,
}: RunGitHubActionsFormatterOptions): void {
	const userOptions = findFormatterOptions(config.formatters, "github-actions");
	if (userOptions === undefined) {
		return;
	}

	const options = resolveGitHubActionsOptions({ sourceMapper, userOptions });

	if (userOptions.displayAnnotations !== false) {
		const annotations = formatAnnotations(result, options);
		if (annotations !== "") {
			process.stderr.write(`${annotations}\n`);
		}
	}

	const { jobSummary } = userOptions;
	if (jobSummary?.enabled !== false) {
		const outputPath = jobSummary?.outputPath ?? process.env["GITHUB_STEP_SUMMARY"];
		if (outputPath !== undefined) {
			const summary = formatJobSummary(result, options);
			fileSystem.appendFileSync(outputPath, summary);
		}
	}
}

/**
 * Every file a single run leaves behind: the result JSON, Game Output,
 * annotations.
 */
async function writeSingleRunSinksAsync({
	config,
	fileSystem,
	mergedResult,
	runtimeResult,
	typecheckResult,
}: Pick<SingleRunResult, "runtimeResult" | "typecheckResult"> & {
	config: ResolvedConfig;
	fileSystem: FileSystem;
	mergedResult: JestResult;
}): Promise<void> {
	await writeResultFileAsync({
		fileSystem,
		outputFile: config.outputFile,
		runtime: runtimeResult?.result,
		typecheck: typecheckResult,
	});

	if (runtimeResult !== undefined) {
		writeGameOutputIfConfigured({
			config,
			fileSystem,
			gameOutput: runtimeResult.gameOutput,
			hintsShown: !mergedResult.success,
		});
	}

	runGitHubActionsFormatter({
		config,
		fileSystem,
		result: mergedResult,
		sourceMapper: runtimeResult?.sourceMapper,
	});
}

// The shared pass/fail tail: single and multi judge a run on the same four
// inputs, so the PASS/FAIL badge and the exit code can't drift between modes.
// Obsolete snapshots (`unchecked`) fail the run just like a snapshot the writer
// couldn't persist.
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
	result: {
		coverageDisplayFilter: agentTextFilter,
		coverageMs,
		runtimeResult,
		stagingMs,
		typecheckResult,
	},
}: {
	config: ResolvedConfig;
	dependencies: ResolvedDependencies;
	result: SingleRunResult;
}): Promise<number> {
	const mergedResult = mergeResults(typecheckResult, runtimeResult?.result);
	const isCoveragePassed = reportSingleRun({
		config,
		dependencies,
		report: {
			agentTextFilter,
			coverageMs,
			mergedResult,
			runtimeResult,
			stagingMs,
			typecheckResult,
		},
	});

	printGapSummary(config, runtimeResult);

	await writeSingleRunSinksAsync({
		config,
		fileSystem: dependencies.fileSystem,
		mergedResult,
		runtimeResult,
		typecheckResult,
	});

	return emitFinalStatus(config, {
		isCoveragePassed,
		mergedResult,
		snapshotWriteFailures: runtimeResult?.snapshotWriteFailures,
	});
}

function mergeProjectExtras(results: Array<ExecuteResult>): ProjectExtras {
	let coverageData: RawCoverageData | undefined;
	let setupMs = 0;
	let snapshotWriteFailures = 0;
	let testsMs = 0;

	for (const entry of results) {
		setupMs += entry.timing.setupMs ?? 0;
		snapshotWriteFailures += entry.snapshotWriteFailures ?? 0;
		testsMs += entry.timing.testsMs;

		coverageData = mergeRawCoverage(coverageData, entry.coverageData);
	}

	return { coverageData, setupMs, snapshotWriteFailures, testsMs };
}

function mergeProjectTiming({
	extras,
	firstResult,
	results,
}: {
	extras: ProjectExtras;
	firstResult: ExecuteResult;
	results: Array<ExecuteResult>;
}): TimingResult {
	return {
		// Upload, coverage, and execution are one shared phase across the
		// projects, so they read off the first result rather than summing.
		coverageMs: firstResult.timing.coverageMs,
		executionMs: firstResult.timing.executionMs,
		setupMs: extras.setupMs > 0 ? extras.setupMs : undefined,
		startTime: Math.min(...results.map((entry) => entry.timing.startTime)),
		testsMs: extras.testsMs,
		totalMs: Math.max(...results.map((entry) => entry.timing.totalMs)),
		uploadMs: firstResult.timing.uploadMs,
	};
}

/**
 * One group per project normally; one batch-scoped group when the runner
 * reports that it captured game output for the batch, which an in-session
 * parallel run does (a `LogService` line cannot be attributed to a project
 * once projects overlap).
 */
function buildAggregatedGroups(projectResults: Array<ProjectResult>): Array<PackageGameOutput> {
	// The runner's own report of what it did, not the flag the run asked for:
	// a parallel request that found no VM host ready runs the sequential path,
	// and one batch group would then throw away every project's log but the
	// first.
	const batched = projectResults.find((entry) => entry.result.gameOutputScope === "batch");
	if (batched !== undefined) {
		return buildBatchGameOutput(batched.result.gameOutput);
	}

	return buildGroupedGameOutput(
		projectResults.map((entry) => {
			return { project: entry.displayName, raw: entry.result.gameOutput };
		}),
	);
}

function writeAggregatedGameOutput({
	config,
	fileSystem,
	hintsShown,
	projectResults,
}: WriteAggregatedGameOutputOptions): void {
	if (config.gameOutput === undefined) {
		return;
	}

	const groups = buildAggregatedGroups(projectResults);
	writeGroupedGameOutput({ filePath: config.gameOutput, fileSystem, groups });

	if (hintsShown !== true && !config.silent) {
		const notice = formatGameOutputNotice(config.gameOutput, countGroupedEntries(groups));
		if (notice) {
			console.error(notice);
		}
	}
}

async function writeMultiRunSinksAsync({
	config,
	fileSystem,
	hintsShown,
	merged,
	projectResults,
	typecheckResult,
}: MultiRunSinks & { config: ResolvedConfig; fileSystem: FileSystem }): Promise<void> {
	await writeResultFileAsync({
		fileSystem,
		outputFile: config.outputFile,
		runtime: merged.result,
		typecheck: typecheckResult,
	});
	writeAggregatedGameOutput({ config, fileSystem, hintsShown, projectResults });
}

function resolveBailSummary(
	result: MultiRunResult | WorkspaceRunResult,
): Pick<MultiOutputContext, "bail"> {
	return result.mode === "workspace" ? { bail: result.bail } : {};
}

function resolveSinkHints(
	result: MultiRunResult | WorkspaceRunResult,
	config: ResolvedConfig,
): Pick<MultiOutputContext, "gameOutputHint" | "outputFileHint"> {
	const gameOutput = result.mode === "workspace" ? result.gameOutput : config.gameOutput;
	const outputFile = result.mode === "workspace" ? result.outputFile : config.outputFile;

	return {
		gameOutputHint: gameOutput,
		outputFileHint: outputFile,
	};
}

function toMultiOutputContext({
	config,
	merged,
	renderer,
	result,
}: ToMultiOutputContextOptions): MultiOutputContext {
	return {
		...resolveBailSummary(result),
		config,
		...resolveSinkHints(result, config),
		coverageMs: result.coverageMs,
		merged,
		projectResults: result.projectResults,
		renderer,
		stagingMs: result.stagingMs,
		typecheckResult: result.typecheckResult,
	};
}

function reportMultiRun({
	context,
	pipeline,
	result,
}: {
	context: MultiOutputContext;
	pipeline: CoveragePipeline;
	result: MultiRunResult | WorkspaceRunResult;
}): boolean {
	const { config, merged } = context;
	const displayFilter = extractCoverageDisplayFilter(result);

	return emitResultsAndCoverage({
		config,
		coverageEnabled: config.collectCoverage,
		printResults: () => {
			printMultiResults(context);
		},
		runCoverage: () => {
			return processCoverage({
				agentTextFilter: displayFilter,
				config,
				coverageData: merged.coverageData,
				packageGates: extractCoveragePackages(result),
				pipeline,
			});
		},
	});
}

async function emitMultiResultAsync({
	config,
	dependencies: { coveragePipeline, fileSystem, renderer },
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
		context: toMultiOutputContext({ config, merged, renderer, result }),
		pipeline: coveragePipeline,
		result,
	});

	printGapSummary(config, merged);

	await writeMultiRunSinksAsync({
		config,
		fileSystem,
		hintsShown: !mergedResult.success,
		merged,
		projectResults,
		typecheckResult,
	});

	runGitHubActionsFormatter({
		config,
		fileSystem,
		result: mergedResult,
		sourceMapper: merged.sourceMapper,
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
