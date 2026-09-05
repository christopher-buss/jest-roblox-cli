import assert from "node:assert";
import process from "node:process";

import { DEFAULT_CONFIG, type ResolvedConfig } from "./config/schema.ts";
import { mergeRawCoverage } from "./coverage-pipeline/merge-raw-coverage.ts";
import type { RawCoverageData } from "./coverage-pipeline/types.ts";
import type { ExecuteResult } from "./executor.ts";
import { mergeSnapshotSummaries } from "./formatters/formatter.ts";
import {
	formatAnnotations,
	formatJobSummary,
	resolveGitHubActionsOptions,
} from "./formatters/github-actions.ts";
import { writeJsonFileAsync } from "./formatters/json.ts";
import { findFormatterOptions, usesAgentFormatter } from "./formatters/utils.ts";
import {
	extractCoverageDisplayFilter,
	extractCoveragePackages,
	printFinalStatus,
	processCoverage,
} from "./reporting/coverage-report.ts";
import {
	type MultiOutputContext,
	printMultiResults,
	printSingleResults,
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
export async function writeResultFileAsync(
	outputFile: string | undefined,
	typecheck: JestResult | undefined,
	runtime: JestResult | undefined,
	fileSystem: FileSystem = nodeFileSystem,
): Promise<void> {
	if (outputFile === undefined) {
		return;
	}

	await writeJsonFileAsync(mergeResults(typecheck, runtime), outputFile, fileSystem);
}

export async function outputSingleResultAsync(
	config: ResolvedConfig,
	{
		coverageDisplayFilter: agentTextFilter,
		coverageMs,
		runtimeResult,
		stagingMs,
		typecheckResult,
	}: SingleRunResult,
	fileSystem: FileSystem = nodeFileSystem,
): Promise<number> {
	const mergedResult = mergeResults(typecheckResult, runtimeResult?.result);
	const isCoveragePassed = reportSingleRun(config, {
		agentTextFilter,
		coverageMs,
		mergedResult,
		runtimeResult,
		stagingMs,
		typecheckResult,
	});

	await writeSingleRunSinksAsync(fileSystem, config, {
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
		timing: mergeProjectTiming(results, firstResult, extras),
	};
}

export async function outputMultiResultAsync(
	rootConfig: ResolvedConfig,
	result: MultiRunResult | WorkspaceRunResult,
	fileSystem: FileSystem = nodeFileSystem,
): Promise<number> {
	const { coverageMs, mode, projectResults, stagingMs, typecheckResult } = result;
	const config = buildReportConfig(rootConfig, result);

	if (typecheckResult !== undefined && projectResults.length === 0) {
		return outputSingleResultAsync(
			config,
			{ coverageMs, mode: "single", stagingMs, typecheckResult },
			fileSystem,
		);
	}

	const merged = mergeProjectResults(projectResults.map((entry) => entry.result));
	const mergedResult = mergeResults(typecheckResult, merged.result);
	const isCoveragePassed = emitMultiResults(toMultiOutputContext(config, result, merged), result);

	// Workspace runs write their own result + Game Output sinks (the runner
	// has package identity, the workspace root, and the consensus-resolved
	// paths); here we only handle the single-config `multi` case.
	if (mode === "multi") {
		await writeResultFileAsync(config.outputFile, typecheckResult, merged.result, fileSystem);

		writeAggregatedGameOutput(fileSystem, config, projectResults, {
			hintsShown: !mergedResult.success,
		});
	}

	runGitHubActionsFormatter(fileSystem, config, mergedResult, merged.sourceMapper);

	return emitFinalStatus(config, {
		isCoveragePassed,
		mergedResult,
		snapshotWriteFailures: merged.snapshotWriteFailures,
	});
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
function reportSingleRun(
	config: ResolvedConfig,
	{
		agentTextFilter,
		coverageMs,
		mergedResult,
		runtimeResult,
		stagingMs,
		typecheckResult,
	}: SingleRunReport,
): boolean {
	return emitResultsAndCoverage({
		config,
		coverageEnabled: config.collectCoverage,
		printResults: () => {
			printSingleResults(config, {
				coverageMs,
				mergedResult,
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
			});
		},
	});
}

function writeGameOutputIfConfigured(
	fileSystem: FileSystem,
	config: ResolvedConfig,
	gameOutput: string | undefined,
	options: { hintsShown?: boolean },
): void {
	if (config.gameOutput === undefined) {
		return;
	}

	const entries = parseGameOutput(gameOutput);
	writeGameOutput(config.gameOutput, entries, fileSystem);

	if (!config.silent && options.hintsShown !== true) {
		const notice = formatGameOutputNotice(config.gameOutput, entries.length);
		if (notice) {
			console.error(notice);
		}
	}
}

function runGitHubActionsFormatter(
	fileSystem: FileSystem,
	config: ResolvedConfig,
	result: JestResult,
	sourceMapper: SourceMapper | undefined,
): void {
	assert(config.formatters !== undefined);
	const userOptions = findFormatterOptions(config.formatters, "github-actions");
	if (userOptions === undefined) {
		return;
	}

	const options = resolveGitHubActionsOptions(userOptions, sourceMapper);

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
async function writeSingleRunSinksAsync(
	fileSystem: FileSystem,
	config: ResolvedConfig,
	{
		mergedResult,
		runtimeResult,
		typecheckResult,
	}: Pick<SingleRunResult, "runtimeResult" | "typecheckResult"> & { mergedResult: JestResult },
): Promise<void> {
	await writeResultFileAsync(
		config.outputFile,
		typecheckResult,
		runtimeResult?.result,
		fileSystem,
	);

	if (runtimeResult !== undefined) {
		writeGameOutputIfConfigured(fileSystem, config, runtimeResult.gameOutput, {
			hintsShown: !mergedResult.success,
		});
	}

	runGitHubActionsFormatter(fileSystem, config, mergedResult, runtimeResult?.sourceMapper);
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

function mergeProjectExtras(results: Array<ExecuteResult>): ProjectExtras {
	let coverageData: RawCoverageData | undefined;
	let setupMs = 0;
	let snapshotWriteFailures = 0;
	let testsMs = 0;

	for (const entry of results) {
		setupMs += entry.timing.setupMs ?? 0;
		snapshotWriteFailures += entry.snapshotWriteFailures ?? 0;
		testsMs += entry.timing.testsMs;

		if (entry.coverageData !== undefined) {
			coverageData = mergeRawCoverage(coverageData, entry.coverageData);
		}
	}

	return { coverageData, setupMs, snapshotWriteFailures, testsMs };
}

function mergeProjectTiming(
	results: Array<ExecuteResult>,
	firstResult: ExecuteResult,
	extras: ProjectExtras,
): TimingResult {
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

// Derives the config the reporter and print layer run under for
// multi/workspace.
//
// A workspace run has no config of its own: the file at cwd is bootstrap only,
// read for `workspace.root` / `workspace.packages` and nothing else, so passing
// it through here made the report universe, the formatters, the sink paths and
// the exit code depend on whichever config happened to sit at the invocation
// directory. Workspace therefore renders off the defaults plus the runner's
// consensus-resolved `reportOptions`, and `collectCoverage` follows whether a
// package actually produced coverage — the opt-in is per package, so there is
// no run-level flag to read.
//
// `reportOptions` is absent on every result that never reached the runner: a
// validation bail, no affected packages, and a run that tested nothing. Dispatch
// returns all three before the output layer sees them — the bail on its
// `validationExitCode`, the other two on having neither project results nor a
// Type Test result. The defaults keep those unreachable cases honest instead of
// reopening the fallback.
function buildReportConfig(
	rootConfig: ResolvedConfig,
	result: MultiRunResult | WorkspaceRunResult,
): ResolvedConfig {
	if (result.mode === "workspace") {
		return {
			...DEFAULT_CONFIG,
			// Only drives the PASS/FAIL badge and the agent-mode print ordering:
			// the reports themselves come off the per-package gates, each with
			// its own reporters, directory, and universe.
			collectCoverage: (result.coveragePackages?.length ?? 0) > 0,
			formatters: ["default"],
			...result.reportOptions,
		};
	}

	const config: ResolvedConfig = { ...rootConfig };
	if (result.collectCoverageFrom !== undefined) {
		config.collectCoverageFrom = result.collectCoverageFrom;
	}

	return config;
}

// Only workspace runs can bail: multi dispatches through static buckets, which
// have no per-package stop point (see `run/workspace-validation.ts`). The
// render layer itself is mode-agnostic — `FormatOptions.bail` means the same
// thing whoever sets it — so only this lookup knows the difference.
function resolveBailSummary(
	result: MultiRunResult | WorkspaceRunResult,
): Pick<MultiOutputContext, "bail"> {
	return result.mode === "workspace" && result.bail !== undefined ? { bail: result.bail } : {};
}

// Workspace sinks are consensus-resolved by the runner (not from the
// workspace-root config), so "View …" hints must point at those resolved
// paths; single/multi use the resolved config values.
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

function toMultiOutputContext(
	config: ResolvedConfig,
	result: MultiRunResult | WorkspaceRunResult,
	merged: ExecuteResult,
): MultiOutputContext {
	return {
		...resolveBailSummary(result),
		config,
		...resolveSinkHints(result, config),
		coverageMs: result.coverageMs,
		merged,
		projectResults: result.projectResults,
		stagingMs: result.stagingMs,
		typecheckResult: result.typecheckResult,
	};
}

function emitMultiResults(
	context: MultiOutputContext,
	result: MultiRunResult | WorkspaceRunResult,
): boolean {
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
			});
		},
	});
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

function writeAggregatedGameOutput(
	fileSystem: FileSystem,
	config: ResolvedConfig,
	projectResults: Array<ProjectResult>,
	options: { hintsShown?: boolean },
): void {
	if (config.gameOutput === undefined) {
		return;
	}

	const groups = buildAggregatedGroups(projectResults);
	writeGroupedGameOutput(config.gameOutput, groups, fileSystem);

	if (!config.silent && options.hintsShown !== true) {
		const notice = formatGameOutputNotice(config.gameOutput, countGroupedEntries(groups));
		if (notice) {
			console.error(notice);
		}
	}
}
