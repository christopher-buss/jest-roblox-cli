import process from "node:process";

import type { ResolvedConfig } from "./config/schema.ts";
import type { ExecuteResult } from "./executor/executor-types.ts";
import {
	formatAnnotations,
	formatJobSummary,
	resolveGitHubActionsOptions,
} from "./formatters/github-actions.ts";
import { writeJsonFileAsync } from "./formatters/json.ts";
import { findFormatterOptions } from "./formatters/utils.ts";
import { mergeResults } from "./output-merge.ts";
import type { ProjectResult, SingleRunResult } from "./run/run-types.ts";
import type { SourceMapper } from "./source-mapper/index.ts";
import type { PackageGameOutput } from "./types/game-output-types.ts";
import type { JestResult } from "./types/jest-result-types.ts";
import { type FileSystem, nodeFileSystem } from "./utils/file-system.ts";
import {
	buildBatchGameOutput,
	buildGroupedGameOutput,
	countGroupedEntries,
	formatGameOutputNotice,
	parseGameOutput,
	writeGameOutput,
	writeGroupedGameOutput,
} from "./utils/game-output.ts";

interface MultiRunSinks {
	merged: ExecuteResult;
	mergedResult: JestResult;
	projectResults: Array<ProjectResult>;
	typecheckResult: JestResult | undefined;
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

/**
 * The single owner of the merged result-file (`outputFile`) sink across every
 * mode — single, multi, and workspace. Gates on the resolved sink path (the one
 * seam where `config.outputFile` vs the workspace consensus path is decided by
 * the caller) and serializes the shared `mergeResults` output. Routing both
 * sides through `mergeResults` here means a new result dimension lands in the
 * file for every mode by a one-line change to that merge, with no second writer
 * to keep in sync.
 * @param options - Filesystem, sink path, and runtime and Type Test results.
 * @returns Resolves when the file is written, or at once when no path is set.
 */
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

/**
 * Every file a single run leaves behind: the result JSON, Game Output,
 * annotations.
 * @param options - Config, filesystem, merged result and the run's results.
 * @returns Resolves when every sink is written.
 */
export async function writeSingleRunSinksAsync({
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

/**
 * Every file a multi or workspace run leaves behind: the result JSON, Game
 * Output, annotations.
 * @param options - Config, filesystem, merged results and per-project results.
 * @returns Resolves when every sink is written.
 */
export async function writeMultiRunSinksAsync({
	config,
	fileSystem,
	merged,
	mergedResult,
	projectResults,
	typecheckResult,
}: MultiRunSinks & { config: ResolvedConfig; fileSystem: FileSystem }): Promise<void> {
	await writeResultFileAsync({
		fileSystem,
		outputFile: config.outputFile,
		runtime: merged.result,
		typecheck: typecheckResult,
	});
	writeAggregatedGameOutput({
		config,
		fileSystem,
		hintsShown: !mergedResult.success,
		projectResults,
	});
	runGitHubActionsFormatter({
		config,
		fileSystem,
		result: mergedResult,
		sourceMapper: merged.sourceMapper,
	});
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

/**
 * One group per project normally; one batch-scoped group when the runner
 * reports that it captured game output for the batch, which an in-session
 * parallel run does (a `LogService` line cannot be attributed to a project
 * once projects overlap).
 * @param projectResults - Results of each project in the run.
 * @returns Game output groups to write.
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
