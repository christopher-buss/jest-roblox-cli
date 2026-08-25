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
	formatTypecheckReport,
} from "../formatters/formatter.ts";
import type { BailSummary } from "../formatters/shared.ts";
import {
	DEFAULT_MAX_FAILURES,
	findFormatterOptions,
	hasFormatter,
	usesAgentFormatter,
} from "../formatters/utils.ts";
import type { PreDispatchTiming, ProjectResult } from "../run/types.ts";
import type { JestResult } from "../types/jest-result.ts";
import type { TimingResult } from "../types/timing.ts";

export interface MultiOutputContext extends PreDispatchTiming {
	/** Workspace `--bail` only: how far the run got before it stopped. */
	bail?: BailSummary | undefined;
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

interface RuntimeOutputOptions {
	runtimeResult: ExecuteResult;
	timing: TimingResult;
	/** Type errors from the parallel type pass, when one ran. */
	typeErrorCount?: number | undefined;
}

interface SingleResultsOptions extends PreDispatchTiming {
	mergedResult: JestResult;
	runtimeResult?: ExecuteResult | undefined;
	typecheckResult?: JestResult | undefined;
}

const VERSION = packageJson.version;

// Prints the run results for `single`, honouring `config.silent` and folding
// the two pre-dispatch phases into the reported timing. The multi/workspace
// twin is `printMultiResults`.
export function printSingleResults(config: ResolvedConfig, options: SingleResultsOptions): void {
	const { mergedResult, runtimeResult, typecheckResult } = options;
	if (config.silent) {
		return;
	}

	const timing =
		runtimeResult !== undefined
			? addPreDispatchTiming(runtimeResult.timing, options)
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
		writeTypecheckReport(config, typecheckResult);
	}
}

// Folds a run's {@link PreDispatchTiming} into the timing the formatters
// render: both phases sit outside the window `totalMs` measures, so each is
// added onto it rather than found inside it.
function addPreDispatchTiming(
	timing: TimingResult,
	{ coverageMs, stagingMs }: PreDispatchTiming,
): TimingResult {
	return {
		...timing,
		coverageMs,
		stagingMs,
		totalMs: timing.totalMs + coverageMs + stagingMs,
	};
}

function printOutput(out: string): void {
	if (out !== "") {
		// eslint-disable-next-line no-console -- CLI result output belongs on stdout.
		console.log(out);
	}
}

function formatRuntimeOutput(
	config: ResolvedConfig,
	{ runtimeResult, timing, typeErrorCount }: RuntimeOutputOptions,
): string {
	return formatExecuteOutput({
		config,
		result: runtimeResult.result,
		snapshotWriteFailures: runtimeResult.snapshotWriteFailures,
		sourceMapper: runtimeResult.sourceMapper,
		timing,
		typeErrorCount,
		version: VERSION,
	});
}

// The agent formatter is plain text throughout, so the type report beside it
// drops colour too rather than being the one block that carries escapes.
function typecheckReportColor(config: ResolvedConfig): boolean {
	return config.color && !usesAgentFormatter(config.formatters, config.verbose);
}

function writeTypecheckReport(config: ResolvedConfig, typecheckResult: JestResult): void {
	const report = formatTypecheckReport(typecheckResult, {
		// The agent formatter builds the summary rows into its own block, so
		// only the failure detail is still missing here.
		includeSummaryRows: !usesAgentFormatter(config.formatters, config.verbose),
		useColor: typecheckReportColor(config),
	});
	// A clean type pass leaves the detail-only report empty; writing it would
	// put a stray blank line on the green path.
	if (report !== "") {
		process.stderr.write(report);
	}
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
		printOutput(
			formatRuntimeOutput(config, {
				runtimeResult,
				timing,
				typeErrorCount: typecheckResult.numFailedTests,
			}),
		);
		writeTypecheckReport(config, typecheckResult);
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

	// A typecheck-only run has no run report beside it, so this is the whole
	// thing: rows included, whatever the formatter.
	if (typecheckResult !== undefined) {
		process.stdout.write(
			formatTypecheckReport(typecheckResult, { useColor: typecheckReportColor(config) }),
		);
		return;
	}

	assert(runtimeResult !== undefined && timing !== undefined, "runtime result required");
	printOutput(formatRuntimeOutput(config, { runtimeResult, timing }));
}

function toProjectEntries(projectResults: Array<ProjectResult>): Array<FormatterProjectEntry> {
	return projectResults.map((entry) => {
		return {
			displayColor: entry.displayColor,
			displayName: entry.displayName,
			gameOutput: entry.result.gameOutput,
			result: entry.result.result,
		};
	});
}

function getAgentMaxFailures(config: ResolvedConfig): number {
	assert(config.formatters !== undefined, "formatters is set by resolveFormatters");
	const options = findFormatterOptions(config.formatters, "agent");
	if (options !== undefined && typeof options.maxFailures === "number") {
		return options.maxFailures;
	}

	return DEFAULT_MAX_FAILURES;
}

function formatAgentMultiOutput({
	bail,
	config,
	gameOutputHint,
	merged,
	outputFileHint,
	projectResults,
	typecheckResult,
}: MultiOutputContext): string {
	return formatAgentMultiProject(toProjectEntries(projectResults), {
		bail,
		gameOutput: gameOutputHint,
		maxFailures: getAgentMaxFailures(config),
		outputFile: outputFileHint,
		rootDir: config.rootDir,
		sourceMapper: merged.sourceMapper,
		typeErrorCount: typecheckResult?.numFailedTests,
	});
}

function printMultiProjectOutput(context: MultiOutputContext): void {
	const { config, merged, projectResults, typecheckResult } = context;

	if (usesAgentFormatter(config.formatters, config.verbose)) {
		printOutput(formatAgentMultiOutput(context));
		return;
	}

	const timing = addPreDispatchTiming(merged.timing, context);
	if (hasFormatter(config.formatters, "json")) {
		printOutput(formatRuntimeOutput(config, { runtimeResult: merged, timing }));
		return;
	}

	printOutput(
		formatMultiProjectResult(toProjectEntries(projectResults), timing, {
			...toFormatOptions(config, VERSION),
			bail: context.bail,
			snapshotWriteFailures: merged.snapshotWriteFailures,
			sourceMapper: merged.sourceMapper,
			typeErrors: typecheckResult?.numFailedTests,
		}),
	);
}
