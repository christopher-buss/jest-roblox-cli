/**
 * Composition root for the human-readable formatter: it assembles the file
 * summaries, detailed failures and totals produced by the sibling modules into
 * the single-project and multi-project reports.
 *
 * It also stays the barrel every consumer imports from — `output.spec.ts`
 * whole-module-automocks this file, and `index.ts` re-exports its public API —
 * so anything that moved to a sibling is re-exported here.
 */

import { mergeJestTotals, mergeSnapshotSummaries } from "../results/merge.ts";
import { hasExecError, type JestResult } from "../types/jest-result.ts";
import type { TimingResult } from "../types/timing.ts";
import { parseGameOutput } from "../utils/game-output.ts";
import { formatExecErrorDetail, formatFileFailures } from "./failure.ts";
import { computeProjectStats, formatFileSummary } from "./file-summary.ts";
import { formatGameOutputBlock } from "./game-output.ts";
import type { FailureContext, FormatOptions, FormatterProjectEntry } from "./shared.ts";
import { createStyles, formatProjectBadge, type Styles } from "./styles.ts";
import {
	countTestBuckets,
	formatFailedTestsHeader,
	formatLogHints,
	formatSummaryParts,
	formatTestsLine,
	formatTestSummary,
	formatTypeErrorsLine,
} from "./summary.ts";

// Re-exported from its home in `results/merge.ts` so the formatter stays the
// import site every consumer already knows (and `output.spec.ts`'s whole-module
// automock of this file keeps covering it).
export { mergeSnapshotSummaries } from "../results/merge.ts";
export {
	cleanExecErrorMessage,
	formatFailure,
	getExecErrorHint,
	parseErrorMessage,
} from "./failure.ts";
export { resolveDisplayPath } from "./shared.ts";
export type { FormatOptions, FormatterProjectEntry } from "./shared.ts";
export { formatSourceSnippet, parseSourceLocation } from "./snippets.ts";
export { formatProjectBadge } from "./styles.ts";
export { formatFailedTestsHeader, formatRunHeader, formatTestSummary } from "./summary.ts";

interface ProjectHeaderOptions {
	displayColor?: string | undefined;
	displayName: string;
	result: JestResult;
	styles?: Styles | undefined;
	useColor?: boolean | undefined;
}

interface TypecheckReportOptions {
	/** Clear when the run report beside this one already carried the rows. */
	includeSummaryRows?: boolean | undefined;
	useColor?: boolean | undefined;
}

interface ProjectSectionOptions {
	displayColor?: string | undefined;
	displayName: string;
	failureCtx: FailureContext;
	gameOutput?: string | undefined;
	options: FormatOptions;
	result: JestResult;
	styles?: Styles | undefined;
}

// No Game Output block here, deliberately: this renders a MERGED JestResult
// with no project identity, and Game Output is per-project. Every runtime
// project result reaches the block through formatProjectSection; the only
// production path left on this function is the typecheck-only report.
export function formatResult(
	result: JestResult,
	timing: TimingResult,
	options: FormatOptions,
): string {
	const styles = createStyles(options.color, options.slowTestThreshold);
	// The run header is emitted at the start of the run (see run/run-header.ts);
	// keep a leading blank line here so results stay visually separated.
	const lines: Array<string> = ["", ...formatFileSummaries(result, options, styles)];

	const totalDetailedFailures = countDetailedFailures(result);
	if (totalDetailedFailures > 0) {
		const failureCtx: FailureContext = {
			currentIndex: 1,
			totalFailures: totalDetailedFailures,
		};
		lines.push(
			"",
			formatFailedTestsHeader(totalDetailedFailures, styles),
			...formatDetailedFailures(result, options, styles, failureCtx),
		);
	}

	lines.push(...formatSummaryAndHints(result, timing, options, styles));

	return lines.join("\n");
}

export function formatProjectHeader({
	displayColor,
	displayName,
	result,
	styles: headerStyles,
	useColor = true,
}: ProjectHeaderOptions): string {
	const resolved = headerStyles ?? createStyles(useColor);
	const stats = computeProjectStats(result);

	const parts = formatSummaryParts(
		{
			failed: stats.failedFiles,
			passed: stats.passedFiles,
			skipped: stats.skippedFiles,
		},
		resolved,
	);

	const duration = stats.durationMs > 0 ? ` - ${stats.durationMs}ms` : "";
	const meta = resolved.dim(`(${stats.totalTests} tests${duration})`);
	const fileStats = parts.join(" | ");
	const badge = formatProjectBadge(displayName, useColor, displayColor);

	return `${badge}  ${fileStats} ${meta}`;
}

export function formatProjectSection({
	displayColor,
	displayName,
	failureCtx,
	gameOutput,
	options,
	result,
	styles: sectionStyles,
}: ProjectSectionOptions): string {
	const resolved = sectionStyles ?? createStyles(options.color, options.slowTestThreshold);
	const lines: Array<string> = [
		formatProjectHeader({
			displayColor,
			displayName,
			result,
			styles: resolved,
			useColor: options.color,
		}),
		...formatFileSummaries(result, options, resolved),
	];

	if (countDetailedFailures(result) > 0) {
		lines.push(...formatDetailedFailures(result, options, resolved, failureCtx));
	}

	// Only a failing project earns its Game Output inline: on a pass the
	// reader has nothing to debug, and the file sinks still hold the full dump.
	if (!result.success) {
		lines.push(...formatGameOutputBlock(parseGameOutput(gameOutput), resolved));
	}

	return lines.join("\n");
}

export function formatMultiProjectResult(
	projects: Array<FormatterProjectEntry>,
	timing: TimingResult,
	options: FormatOptions,
): string {
	const styles = createStyles(options.color, options.slowTestThreshold);

	// One counter threaded through every project so the `[n/total]` footers run
	// as a single sequence across the whole report.
	const failureCtx: FailureContext = {
		currentIndex: 1,
		totalFailures: projects.reduce((sum, { result }) => sum + countDetailedFailures(result), 0),
	};

	const sections = projects.map(({ displayColor, displayName, gameOutput, result }) => {
		return formatProjectSection({
			displayColor,
			displayName,
			failureCtx,
			gameOutput,
			options,
			result,
			styles,
		});
	});

	// The run header is emitted at the start of the run (see run/run-header.ts);
	// keep a leading blank line so results stay visually separated.
	const lines: Array<string> = ["", sections.join("\n\n")];

	const mergedResult = mergeJestResults(projects.map((project) => project.result));
	lines.push(...formatSummaryAndHints(mergedResult, timing, options, styles));

	return lines.join("\n");
}

/**
 * The typecheck report for the formatters that render the runtime run
 * themselves and leave the type results to this: the failing type assertions,
 * then the same `Tests` and `Type Errors` rows the default formatter emits, so
 * the wording does not shift with the chosen formatter.
 *
 * Clear `includeSummaryRows` when the run report beside this one already
 * carried those rows — the agent formatter builds them into its own summary
 * block — leaving the failure detail as the only thing missing. A report with
 * no run report beside it owns every row, so the counts travel with it.
 */
export function formatTypecheckReport(
	result: JestResult,
	{ includeSummaryRows = true, useColor = true }: TypecheckReportOptions = {},
): string {
	const styles = createStyles(useColor);
	const failed = result.numFailedTests;

	// Every non-empty report ends on a newline. It is written straight to a
	// stream, so an unterminated last line runs into whatever prints next.
	const detail = failed > 0 ? `${formatTypecheckFailures(result, styles)}\n` : "";

	if (!includeSummaryRows) {
		return detail;
	}

	const rows = [
		formatTestsLine(countTestBuckets(result), styles),
		formatTypeErrorsLine(failed, styles),
	];

	return `${detail}\n${rows.join("\n")}\n`;
}

/**
 * Phase 1 of a report: one summary block per test file, minus filtered files.
 */
function formatFileSummaries(
	result: JestResult,
	options: FormatOptions,
	styles: Styles,
): Array<string> {
	const lines: Array<string> = [];

	for (const file of result.testResults) {
		if (options.failuresOnly === true && file.numFailingTests === 0 && !hasExecError(file)) {
			continue;
		}

		lines.push(formatFileSummary(file, options, styles));
	}

	return lines;
}

/**
 * The count the `[n/total]` failure footers are numbered against: failed test
 * cases plus files whose suite never ran.
 */
function countDetailedFailures(result: JestResult): number {
	return result.numFailedTests + result.testResults.filter(hasExecError).length;
}

/** Phase 2 of a report: the expanded failure blocks, in file order. */
function formatDetailedFailures(
	result: JestResult,
	options: FormatOptions,
	styles: Styles,
	failureCtx: FailureContext,
): Array<string> {
	const lines: Array<string> = [];
	const execErrors = result.testResults.filter(hasExecError);

	for (const file of result.testResults) {
		const failures = formatFileFailures(file, options, styles, failureCtx);
		if (failures !== "") {
			lines.push(failures);
		}
	}

	for (const file of execErrors) {
		lines.push(formatExecErrorDetail(file, styles, failureCtx, options.sourceMapper));
	}

	return lines;
}

/** Phase 3 of a report: the totals block, plus the hints a failed run earns. */
function formatSummaryAndHints(
	result: JestResult,
	timing: TimingResult,
	options: FormatOptions,
	styles: Styles,
): Array<string> {
	const lines: Array<string> = [
		"",
		formatTestSummary(result, timing, styles, {
			bail: options.bail,
			snapshotWriteFailures: options.snapshotWriteFailures,
			typeErrors: options.typeErrors,
		}),
	];

	if (!result.success) {
		const hints = formatLogHints(options, styles, result.snapshot);
		if (hints !== "") {
			lines.push("", hints);
		}
	}

	return lines;
}

function mergeJestResults(results: Array<JestResult>): JestResult {
	const snapshots = results
		.map((result) => result.snapshot)
		.filter((snapshot) => snapshot !== undefined);

	return { ...mergeJestTotals(results), snapshot: mergeSnapshotSummaries(snapshots) };
}

function formatTypecheckFileFailures(
	file: JestResult["testResults"][number],
	styles: Styles,
): Array<string> {
	const lines: Array<string> = [];
	for (const test of file.testResults) {
		if (test.status !== "failed") {
			continue;
		}

		const badge = styles.failBadge(" FAIL ");
		lines.push(`  ${badge} ${styles.status.fail(test.fullName)}`);
		for (const message of test.failureMessages) {
			lines.push(`    ${styles.dim(message)}`);
		}
	}

	return lines;
}

/** The expanded type-failure blocks, without the closing summary rows. */
function formatTypecheckFailures(result: JestResult, styles: Styles): string {
	const lines: Array<string> = [];

	for (const file of result.testResults) {
		lines.push(...formatTypecheckFileFailures(file, styles));
	}

	return lines.join("\n");
}
