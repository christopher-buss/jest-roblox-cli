import assert from "node:assert";
import process from "node:process";

import packageJson from "../../package.json" with { type: "json" };
import type { ResolvedConfig } from "../config/schema.ts";
import { type ExecuteResult, formatExecuteOutput } from "../executor.ts";
import { formatAgentMultiProject } from "../formatters/agent.ts";
import { toFormatOptions } from "../formatters/format-options.ts";
import {
	formatMultiProjectResult,
	formatResult,
	type FormatterProjectEntry,
	formatTypecheckSummary,
} from "../formatters/formatter.ts";
import {
	DEFAULT_MAX_FAILURES,
	findFormatterOptions,
	hasFormatter,
	usesAgentFormatter,
} from "../formatters/utils.ts";
import type { ProjectResult } from "../run/types.ts";
import type { JestResult } from "../types/jest-result.ts";
import type { TimingResult } from "../types/timing.ts";

export interface MultiOutputContext {
	config: ResolvedConfig;
	/**
	 * Resolved Game Output path for "View …" hints (workspace consensus or
	 * config).
	 */
	gameOutputHint?: string | undefined;
	merged: ExecuteResult;
	/**
	 * Resolved result-file path for "View …" hints (workspace consensus or
	 * config).
	 */
	outputFileHint?: string | undefined;
	preCoverageMs: number;
	projectResults: Array<ProjectResult>;
	typecheckResult?: JestResult | undefined;
}

interface FormattedOutputOptions {
	config: ResolvedConfig;
	mergedResult: JestResult;
	runtimeResult?: ExecuteResult | undefined;
	timing?: TimingResult | undefined;
	typecheckResult?: JestResult | undefined;
}

interface SingleResultsOptions {
	mergedResult: JestResult;
	preCoverageMs: number;
	runtimeResult?: ExecuteResult | undefined;
	typecheckResult?: JestResult | undefined;
}

const VERSION: string = packageJson.version;

// Prints the run results for `single`, honouring `config.silent` and folding
// the deferred coverage phase into the reported timing. The multi/workspace
// twin is `printMultiResults`.
export function printSingleResults(
	config: ResolvedConfig,
	{ mergedResult, preCoverageMs, runtimeResult, typecheckResult }: SingleResultsOptions,
): void {
	if (config.silent) {
		return;
	}

	const timing =
		runtimeResult !== undefined
			? addCoverageTiming(runtimeResult.timing, preCoverageMs)
			: undefined;
	printFormattedOutput({ config, mergedResult, runtimeResult, timing, typecheckResult });
}

// Prints the run results for `multi`/`workspace`, honouring the same
// formatter precedence as the single-run path: agent, then json, then the
// default multi-project renderer.
export function printMultiResults(context: MultiOutputContext): void {
	const { config, typecheckResult } = context;
	if (config.silent) {
		return;
	}

	printMultiProjectOutput(context);

	if (typecheckResult !== undefined && !usesDefaultFormatter(config)) {
		process.stderr.write(formatTypecheckSummary(typecheckResult));
	}
}

function addCoverageTiming(timing: TimingResult, coverageMs: number): TimingResult {
	return { ...timing, coverageMs, totalMs: timing.totalMs + coverageMs };
}

function printOutput(out: string): void {
	if (out !== "") {
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
		snapshotWriteFailures: runtimeResult.snapshotWriteFailures,
		sourceMapper: runtimeResult.sourceMapper,
		timing,
		version: VERSION,
	});
}

function usesDefaultFormatter(config: ResolvedConfig): boolean {
	return (
		!hasFormatter(config.formatters, "json") &&
		!usesAgentFormatter(config.formatters, config.verbose)
	);
}

function printCombinedOutput(
	config: ResolvedConfig,
	{
		mergedResult,
		runtimeResult,
		timing,
		typecheckResult,
	}: {
		mergedResult: JestResult;
		runtimeResult: ExecuteResult;
		timing: TimingResult;
		typecheckResult: JestResult;
	},
): void {
	if (!usesDefaultFormatter(config)) {
		printOutput(formatRuntimeOutput(config, runtimeResult, timing));
		process.stderr.write(formatTypecheckSummary(typecheckResult));
		return;
	}

	printOutput(
		formatResult(mergedResult, timing, {
			...toFormatOptions(config, VERSION),
			snapshotWriteFailures: runtimeResult.snapshotWriteFailures,
			sourceMapper: runtimeResult.sourceMapper,
			typeErrors: typecheckResult.numFailedTests,
		}),
	);
}

function printFormattedOutput({
	config,
	mergedResult,
	runtimeResult,
	timing,
	typecheckResult,
}: FormattedOutputOptions): void {
	if (typecheckResult !== undefined && runtimeResult !== undefined && timing !== undefined) {
		printCombinedOutput(config, { mergedResult, runtimeResult, timing, typecheckResult });
		return;
	}

	if (typecheckResult !== undefined) {
		process.stdout.write(formatTypecheckSummary(typecheckResult));
		return;
	}

	assert(runtimeResult !== undefined && timing !== undefined, "runtime result required");
	printOutput(formatRuntimeOutput(config, runtimeResult, timing));
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

function getAgentMaxFailures(config: ResolvedConfig): number {
	assert(config.formatters !== undefined, "formatters is set by resolveFormatters");
	const options = findFormatterOptions(config.formatters, "agent");
	if (options !== undefined && typeof options["maxFailures"] === "number") {
		return options["maxFailures"];
	}

	return DEFAULT_MAX_FAILURES;
}

function formatAgentMultiOutput({
	config,
	gameOutputHint,
	merged,
	outputFileHint,
	projectResults,
	typecheckResult,
}: MultiOutputContext): string {
	return formatAgentMultiProject(toProjectEntries(projectResults), {
		gameOutput: gameOutputHint,
		maxFailures: getAgentMaxFailures(config),
		outputFile: outputFileHint,
		rootDir: config.rootDir,
		sourceMapper: merged.sourceMapper,
		typeErrorCount: typecheckResult?.numFailedTests,
	});
}

function printMultiProjectOutput(context: MultiOutputContext): void {
	const { config, merged, preCoverageMs, projectResults, typecheckResult } = context;

	if (usesAgentFormatter(config.formatters, config.verbose)) {
		printOutput(formatAgentMultiOutput(context));
		return;
	}

	const timing = addCoverageTiming(merged.timing, preCoverageMs);
	if (hasFormatter(config.formatters, "json")) {
		printOutput(formatRuntimeOutput(config, merged, timing));
		return;
	}

	printOutput(
		formatMultiProjectResult(toProjectEntries(projectResults), timing, {
			...toFormatOptions(config, VERSION),
			snapshotWriteFailures: merged.snapshotWriteFailures,
			sourceMapper: merged.sourceMapper,
			typeErrors: typecheckResult?.numFailedTests,
		}),
	);
}
