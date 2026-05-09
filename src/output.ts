import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import color from "tinyrainbow";

import packageJson from "../package.json" with { type: "json" };
import type { ResolvedConfig } from "./config/schema.ts";
import { mapCoverageToTypeScript } from "./coverage/mapper.ts";
import { mergeRawCoverage } from "./coverage/merge-raw-coverage.ts";
import { checkThresholds, generateReports, printCoverageHeader } from "./coverage/reporter.ts";
import type { RawCoverageData } from "./coverage/types.ts";
import { type ExecuteResult, formatExecuteOutput, loadCoverageManifest } from "./executor.ts";
import { formatAgentMultiProject } from "./formatters/agent.ts";
import {
	formatMultiProjectResult,
	formatResult,
	type FormatterProjectEntry,
	formatTypecheckSummary,
} from "./formatters/formatter.ts";
import {
	formatAnnotations,
	formatJobSummary,
	type GitHubActionsFormatterOptions,
	resolveGitHubActionsOptions,
} from "./formatters/github-actions.ts";
import { writeJsonFile } from "./formatters/json.ts";
import {
	DEFAULT_MAX_FAILURES,
	findFormatterOptions,
	hasFormatter,
	usesAgentFormatter,
} from "./formatters/utils.ts";
import type {
	MultiRunResult,
	ProjectResult,
	SingleRunResult,
	WorkspaceRunResult,
} from "./run/types.ts";
import { combineSourceMappers, type SourceMapper } from "./source-mapper/index.ts";
import type { JestResult } from "./types/jest-result.ts";
import type { TimingResult } from "./types/timing.ts";
import { formatGameOutputNotice, parseGameOutput, writeGameOutput } from "./utils/game-output.ts";

const VERSION: string = packageJson.version;

interface FormattedOutputOptions {
	config: ResolvedConfig;
	mergedResult: JestResult;
	runtimeResult?: ExecuteResult;
	timing?: TimingResult;
	typecheckResult?: JestResult;
}

interface MultiOutputContext {
	config: ResolvedConfig;
	merged: ExecuteResult;
	preCoverageMs: number;
	projectResults: Array<ProjectResult>;
	typecheckResult?: JestResult;
}

export async function outputSingleResult(
	config: ResolvedConfig,
	result: SingleRunResult,
): Promise<number> {
	const { preCoverageMs, runtimeResult, typecheckResult } = result;
	const mergedResult = mergeResults(typecheckResult, runtimeResult?.result);

	if (!config.silent) {
		const timing =
			runtimeResult !== undefined
				? addCoverageTiming(runtimeResult.timing, preCoverageMs)
				: undefined;
		printFormattedOutput({ config, mergedResult, runtimeResult, timing, typecheckResult });
	}

	const coveragePassed = processCoverage(config, runtimeResult?.coverageData);

	if (config.outputFile !== undefined) {
		await writeJsonFile(mergedResult, config.outputFile);
	}

	if (runtimeResult !== undefined) {
		writeGameOutputIfConfigured(config, runtimeResult.gameOutput, {
			hintsShown: !mergedResult.success,
		});
	}

	runGitHubActionsFormatter(config, mergedResult, runtimeResult?.sourceMapper);

	const passed = mergedResult.success && coveragePassed;
	if (!config.silent && config.collectCoverage) {
		printFinalStatus(passed);
	}

	return passed ? 0 : 1;
}

export function mergeProjectResults(results: Array<ExecuteResult>): ExecuteResult {
	assert(results.length > 0, "mergeProjectResults requires at least one result");

	if (results.length === 1) {
		const [first] = results as [ExecuteResult];
		return first;
	}

	let numberFailedTests = 0;
	let numberPassedTests = 0;
	let numberPendingTests = 0;
	let numberTodoTests = 0;
	let numberTotalTests = 0;
	let startTime = Number.POSITIVE_INFINITY;
	let success = true;
	const testResults: Array<JestResult["testResults"][number]> = [];
	let testsMs = 0;
	let setupMs = 0;
	let mergedCoverage: RawCoverageData | undefined;

	for (const result of results) {
		numberFailedTests += result.result.numFailedTests;
		numberPassedTests += result.result.numPassedTests;
		numberPendingTests += result.result.numPendingTests;
		numberTodoTests += result.result.numTodoTests ?? 0;
		numberTotalTests += result.result.numTotalTests;
		startTime = Math.min(startTime, result.result.startTime);
		success &&= result.result.success;
		testResults.push(...result.result.testResults);
		testsMs += result.timing.testsMs;
		setupMs += result.timing.setupMs ?? 0;
		if (result.coverageData !== undefined) {
			mergedCoverage = mergeRawCoverage(mergedCoverage, result.coverageData);
		}
	}

	const [sharedTiming] = results as [ExecuteResult, ...Array<ExecuteResult>];
	const mergedStartTime = Math.min(...results.map((entry) => entry.timing.startTime));
	const totalMs = Math.max(...results.map((entry) => entry.timing.totalMs));

	const mergedSourceMapper = combineSourceMappers(
		results.flatMap((entry) => (entry.sourceMapper !== undefined ? [entry.sourceMapper] : [])),
	);

	return {
		coverageData: mergedCoverage,
		exitCode: success ? 0 : 1,
		output: "",
		result: {
			numFailedTests: numberFailedTests,
			numPassedTests: numberPassedTests,
			numPendingTests: numberPendingTests,
			numTodoTests: numberTodoTests,
			numTotalTests: numberTotalTests,
			startTime,
			success,
			testResults,
		},
		sourceMapper: mergedSourceMapper,
		timing: {
			coverageMs: sharedTiming.timing.coverageMs,
			executionMs: sharedTiming.timing.executionMs,
			setupMs: setupMs > 0 ? setupMs : undefined,
			startTime: mergedStartTime,
			testsMs,
			totalMs,
			uploadCached: sharedTiming.timing.uploadCached,
			uploadMs: sharedTiming.timing.uploadMs,
		},
	};
}

export async function outputMultiResult(
	rootConfig: ResolvedConfig,
	result: MultiRunResult | WorkspaceRunResult,
): Promise<number> {
	const { preCoverageMs, projectResults, typecheckResult } = result;
	const collectCoverageFrom =
		"collectCoverageFrom" in result ? result.collectCoverageFrom : undefined;
	const config: ResolvedConfig =
		collectCoverageFrom !== undefined ? { ...rootConfig, collectCoverageFrom } : rootConfig;

	if (projectResults.length === 0 && typecheckResult !== undefined) {
		return outputSingleResult(config, {
			mode: "single",
			preCoverageMs,
			typecheckResult,
		});
	}

	const merged = mergeProjectResults(projectResults.map((entry) => entry.result));
	const mergedResult = mergeResults(typecheckResult, merged.result);

	if (!config.silent) {
		printMultiProjectOutput({
			config,
			merged,
			preCoverageMs,
			projectResults,
			typecheckResult,
		});

		if (typecheckResult !== undefined && !usesDefaultFormatter(config)) {
			process.stderr.write(formatTypecheckSummary(typecheckResult));
		}
	}

	const coveragePassed = processCoverage(config, merged.coverageData);

	if (config.outputFile !== undefined) {
		await writeJsonFile(mergedResult, config.outputFile);
	}

	writeAggregatedGameOutput(config, projectResults, {
		hintsShown: !mergedResult.success,
	});

	runGitHubActionsFormatter(config, mergedResult, merged.sourceMapper);

	const passed = mergedResult.success && coveragePassed;
	if (!config.silent && config.collectCoverage) {
		printFinalStatus(passed);
	}

	return passed ? 0 : 1;
}

function mergeResults(
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
			startTime: Math.min(typecheck.startTime, runtime.startTime),
			success: typecheck.success && runtime.success,
			testResults: [...typecheck.testResults, ...runtime.testResults],
		};
	}

	const result = typecheck ?? runtime;
	assert(result !== undefined, "mergeResults requires at least one result");
	return result;
}

function addCoverageTiming(timing: TimingResult, coverageMs: number): TimingResult {
	return { ...timing, coverageMs, totalMs: timing.totalMs + coverageMs };
}

function usesDefaultFormatter(config: ResolvedConfig): boolean {
	return !hasFormatter(config, "json") && !usesAgentFormatter(config);
}

function printOutput(out: string): void {
	if (out !== "") {
		// eslint-disable-next-line no-console -- formatted output is intentional stdout
		console.log(out);
	}
}

function formatRuntimeOutput(
	config: ResolvedConfig,
	runtimeResult: ExecuteResult,
	timing: TimingResult,
): string {
	return formatExecuteOutput({
		config,
		result: runtimeResult.result,
		sourceMapper: runtimeResult.sourceMapper,
		timing,
		version: VERSION,
	});
}

function printFormattedOutput(options: FormattedOutputOptions): void {
	const { config, mergedResult, runtimeResult, timing, typecheckResult } = options;

	if (typecheckResult !== undefined && runtimeResult !== undefined && timing !== undefined) {
		if (usesDefaultFormatter(config)) {
			printOutput(
				formatResult(mergedResult, timing, {
					collectCoverage: config.collectCoverage,
					color: config.color,
					rootDir: config.rootDir,
					showLuau: config.showLuau,
					slowTestThreshold: config.slowTestThreshold,
					sourceMapper: runtimeResult.sourceMapper,
					typeErrors: typecheckResult.numFailedTests,
					verbose: config.verbose,
					version: VERSION,
				}),
			);
		} else {
			printOutput(formatRuntimeOutput(config, runtimeResult, timing));
			process.stderr.write(formatTypecheckSummary(typecheckResult));
		}

		return;
	}

	if (typecheckResult !== undefined) {
		process.stdout.write(formatTypecheckSummary(typecheckResult));
		return;
	}

	assert(runtimeResult !== undefined && timing !== undefined, "runtime result required");
	printOutput(formatRuntimeOutput(config, runtimeResult, timing));
}

function processCoverage(
	config: ResolvedConfig,
	coverageData: RawCoverageData | undefined,
): boolean {
	if (!config.collectCoverage) {
		return true;
	}

	if (coverageData === undefined) {
		if (!config.silent) {
			process.stderr.write(
				"Warning: coverage data was empty — the Rojo project may point at uninstrumented source\n",
			);
		}

		return true;
	}

	const manifest = loadCoverageManifest(config.rootDir);
	if (manifest === undefined) {
		if (!config.silent) {
			process.stderr.write("Warning: Coverage manifest not found, skipping TS mapping\n");
		}

		return true;
	}

	const mapped = mapCoverageToTypeScript(coverageData, manifest);
	const coverageDirectory = path.resolve(config.rootDir, config.coverageDirectory);

	if (!config.silent) {
		printCoverageHeader();
	}

	generateReports({
		agentMode: usesAgentFormatter(config),
		collectCoverageFrom: config.collectCoverageFrom,
		coverageDirectory,
		mapped,
		reporters: config.coverageReporters,
	});

	if (config.coverageThreshold !== undefined) {
		const result = checkThresholds(
			mapped,
			config.coverageThreshold,
			config.collectCoverageFrom,
		);
		if (!result.passed) {
			for (const failure of result.failures) {
				process.stderr.write(
					`Coverage threshold not met for ${failure.metric}: ${String(failure.actual.toFixed(2))}% < ${String(failure.threshold)}%\n`,
				);
			}

			return false;
		}
	}

	return true;
}

function runGitHubActionsFormatter(
	config: ResolvedConfig,
	result: JestResult,
	sourceMapper: SourceMapper | undefined,
): void {
	assert(config.formatters !== undefined, "formatters is set by resolveFormatters");
	const userOptions = findFormatterOptions(config.formatters, "github-actions");
	if (userOptions === undefined) {
		return;
	}

	const typedOptions = userOptions as GitHubActionsFormatterOptions;
	const options = resolveGitHubActionsOptions(typedOptions, sourceMapper);

	if (typedOptions.displayAnnotations !== false) {
		const annotations = formatAnnotations(result, options);
		if (annotations !== "") {
			process.stderr.write(`${annotations}\n`);
		}
	}

	const { jobSummary } = typedOptions;
	if (jobSummary?.enabled !== false) {
		const outputPath = jobSummary?.outputPath ?? process.env["GITHUB_STEP_SUMMARY"];
		if (outputPath !== undefined) {
			const summary = formatJobSummary(result, options);
			fs.appendFileSync(outputPath, summary);
		}
	}
}

function writeGameOutputIfConfigured(
	config: ResolvedConfig,
	gameOutput: string | undefined,
	options: { hintsShown?: boolean },
): void {
	if (config.gameOutput === undefined) {
		return;
	}

	const entries = parseGameOutput(gameOutput);
	writeGameOutput(config.gameOutput, entries);

	if (!config.silent && options.hintsShown !== true) {
		const notice = formatGameOutputNotice(config.gameOutput, entries.length);
		if (notice) {
			console.error(notice);
		}
	}
}

function printFinalStatus(passed: boolean): void {
	const badge = passed
		? color.bgGreen(color.black(color.bold(" PASS ")))
		: color.bgRed(color.white(color.bold(" FAIL ")));
	process.stdout.write(`${badge}\n`);
}

function getAgentMaxFailures(config: ResolvedConfig): number {
	assert(config.formatters !== undefined, "formatters is set by resolveFormatters");
	const options = findFormatterOptions(config.formatters, "agent");
	if (options !== undefined && typeof options["maxFailures"] === "number") {
		return options["maxFailures"];
	}

	return DEFAULT_MAX_FAILURES;
}

function toProjectEntries(projectResults: Array<ProjectResult>): Array<FormatterProjectEntry> {
	return projectResults.map((entry) => {
		return {
			displayColor: entry.displayColor,
			displayName: entry.displayName,
			result: entry.result.result,
		};
	});
}

function printMultiProjectOutput(options: MultiOutputContext): void {
	const { config, merged, preCoverageMs, projectResults, typecheckResult } = options;
	const timing = addCoverageTiming(merged.timing, preCoverageMs);

	if (usesAgentFormatter(config)) {
		printOutput(
			formatAgentMultiProject(toProjectEntries(projectResults), {
				gameOutput: config.gameOutput,
				maxFailures: getAgentMaxFailures(config),
				outputFile: config.outputFile,
				rootDir: config.rootDir,
				sourceMapper: merged.sourceMapper,
				typeErrorCount: typecheckResult?.numFailedTests,
			}),
		);
		return;
	}

	if (hasFormatter(config, "json")) {
		printOutput(formatRuntimeOutput(config, merged, timing));
		return;
	}

	printOutput(
		formatMultiProjectResult(toProjectEntries(projectResults), timing, {
			collectCoverage: config.collectCoverage,
			color: config.color,
			rootDir: config.rootDir,
			showLuau: config.showLuau,
			slowTestThreshold: config.slowTestThreshold,
			sourceMapper: merged.sourceMapper,
			typeErrors: typecheckResult?.numFailedTests,
			verbose: config.verbose,
			version: VERSION,
		}),
	);
}

function writeAggregatedGameOutput(
	config: ResolvedConfig,
	projectResults: Array<ProjectResult>,
	options: { hintsShown?: boolean },
): void {
	if (config.gameOutput === undefined) {
		return;
	}

	const entries = projectResults.flatMap((entry) => parseGameOutput(entry.result.gameOutput));
	writeGameOutput(config.gameOutput, entries);

	if (!config.silent && options.hintsShown !== true) {
		const notice = formatGameOutputNotice(config.gameOutput, entries.length);
		if (notice) {
			console.error(notice);
		}
	}
}
