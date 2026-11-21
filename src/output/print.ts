import process from "node:process";

import { selectTerminalFormatter, usesAgentFormatter } from "../config/formatter-selection.ts";
import type { ExecuteResult } from "../executor/executor-types.ts";
import { formatAgentMultiProject } from "../formatters/agent.ts";
import { toFormatOptions } from "../formatters/format-options.ts";
import { formatMultiProjectResult, formatTypecheckReport } from "../formatters/formatter.ts";
import { formatJson } from "../formatters/json.ts";
import type { AffectedSummary, FormatterProjectEntry } from "../formatters/shared.ts";
import type {
	OutputSettings,
	PreDispatchTiming,
	ProjectResult,
} from "../results/run-result-types.ts";
import { createStyles, type Styles } from "../terminal/palette.ts";
import type { BailSummary } from "../types/bail-summary-types.ts";
import type { JestResult } from "../types/jest-result-types.ts";
import type { TimingResult } from "../types/timing-types.ts";
import { VERSION } from "../version.ts";

/** What {@link printRunResults} renders. */
export interface RunPrintContext extends PreDispatchTiming {
	/** Partial Run only; see {@link AffectedSummary}. */
	affected?: AffectedSummary | undefined;
	/** How far a `--bail` run got before it stopped. */
	bail?: BailSummary | undefined;
	/** The result of each project. */
	projectResults: Array<ProjectResult>;
	/** The projects' results merged; absent when no runtime job ran. */
	runtime: ExecuteResult | undefined;
	/** Resolved render settings. */
	settings: OutputSettings;
	/** The type-test pass result, when one ran. */
	typecheckResult?: JestResult | undefined;
}

interface RuntimePrintContext extends RunPrintContext {
	runtime: ExecuteResult;
}

/**
 * Prints the run results with the agent, json or default formatter, in that
 * order of precedence. A run with no runtime job prints the type report alone.
 * @param context - The run's results and settings.
 */
export function printRunResults(context: RunPrintContext): void {
	const { runtime, settings, typecheckResult } = context;
	if (settings.silent) {
		return;
	}

	if (runtime === undefined) {
		if (typecheckResult !== undefined) {
			process.stdout.write(
				formatTypecheckReport(typecheckResult, {
					styles: typecheckReportStyles(settings),
				}),
			);
		}

		return;
	}

	// oxlint-disable-next-line no-console -- CLI result output belongs on stdout.
	console.log(formatRuntimeOutput({ ...context, runtime }));

	if (typecheckResult !== undefined && !usesDefaultFormatter(settings)) {
		writeTypecheckReport({ settings, typecheckResult });
	}
}

function typecheckReportStyles(settings: OutputSettings): Styles {
	return createStyles(settings.color && !usesAgentFormatter(settings));
}

function writeTypecheckReport({
	settings,
	typecheckResult,
}: {
	settings: OutputSettings;
	typecheckResult: JestResult;
}): void {
	process.stderr.write(
		formatTypecheckReport(typecheckResult, {
			includeSummaryRows: !usesAgentFormatter(settings),
			styles: typecheckReportStyles(settings),
		}),
	);
}

function usesDefaultFormatter(settings: OutputSettings): boolean {
	return selectTerminalFormatter(settings).name === "default";
}

function toProjectEntries(projectResults: Array<ProjectResult>): Array<FormatterProjectEntry> {
	return projectResults.map((entry) => {
		return {
			displayColor: entry.displayColor,
			displayName: entry.displayName,
			gameOutput: entry.result.gameOutput,
			result: entry.result.result,
			rootDir: entry.rootDir,
		};
	});
}

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

function formatDefaultOutput(context: RuntimePrintContext): string {
	const { projectResults, runtime, settings, typecheckResult } = context;
	return formatMultiProjectResult({
		options: {
			...toFormatOptions(settings, VERSION),
			affected: context.affected,
			bail: context.bail,
			snapshotWriteFailures: runtime.snapshotWriteFailures,
			sourceMapper: runtime.sourceMapper,
			typeErrors: typecheckResult?.numFailedTests,
		},
		projects: toProjectEntries(projectResults),
		timing: addPreDispatchTiming(runtime.timing, context),
	});
}

function formatRuntimeOutput(context: RuntimePrintContext): string {
	const { projectResults, runtime, settings, typecheckResult } = context;

	const formatter = selectTerminalFormatter(settings);
	if (formatter.name === "agent") {
		return formatAgentMultiProject(toProjectEntries(projectResults), {
			affected: context.affected,
			bail: context.bail,
			gameOutput: settings.gameOutput,
			maxFailures: formatter.maxFailures,
			outputFile: settings.outputFile,
			rootDir: settings.rootDir,
			sourceMapper: runtime.sourceMapper,
			typeErrorCount: typecheckResult?.numFailedTests,
		});
	}

	if (formatter.name === "json") {
		return formatJson(runtime.result, settings.rootDir);
	}

	return formatDefaultOutput(context);
}
