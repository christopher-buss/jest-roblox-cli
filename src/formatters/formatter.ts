import { parseGameOutput } from "../game-output/game-output.ts";
import { createStyles, formatProjectBadge, type Styles } from "../terminal/palette.ts";
import { hasExecError } from "../types/exec-error-file.ts";
import { mergeJestResults } from "../types/jest-result-merge.ts";
import type { JestResult } from "../types/jest-result-types.ts";
import type { TimingResult } from "../types/timing-types.ts";
import { formatFailedTestsHeader } from "./failure-model.ts";
import { formatExecErrorDetail, formatFileFailures } from "./failure.ts";
import { computeProjectStats, formatFileSummary } from "./file-summary.ts";
import { formatGameOutputBlock } from "./game-output.ts";
import {
	type FailureContext,
	type FormatOptions,
	type FormatterProjectEntry,
	withPackageRoot,
} from "./shared.ts";
import {
	countTestBuckets,
	formatLogHints,
	formatSummaryParts,
	formatTestsLine,
	formatTestSummary,
	formatTypeErrorsLine,
} from "./summary.ts";

/**
 * Inputs of `formatResult`.
 */
export interface FormatResultOptions {
	/**
	 * Format options.
	 */
	options: FormatOptions;
	/**
	 * Merged result to report.
	 */
	result: JestResult;
	/**
	 * Run timing for the summary.
	 */
	timing: TimingResult;
}

/**
 * Inputs of `formatMultiProjectResult`.
 */
export interface FormatMultiProjectResultOptions {
	/**
	 * Format options.
	 */
	options: FormatOptions;
	/**
	 * Each project's name, color, Game Output and result.
	 */
	projects: Array<FormatterProjectEntry>;
	/**
	 * Run timing for the summary.
	 */
	timing: TimingResult;
}

interface ReportPhaseOptions {
	options: FormatOptions;
	result: JestResult;
	styles: Styles;
}

interface ProjectHeaderOptions {
	displayColor?: string | undefined;
	displayName: string;
	result: JestResult;
	styles: Styles;
}

interface TypecheckReportOptions {
	includeSummaryRows?: boolean | undefined;
	styles: Styles;
}

interface ProjectSectionOptions {
	displayColor?: string | undefined;
	displayName: string;
	failureCtx: FailureContext;
	gameOutput?: string | undefined;
	options: FormatOptions;
	packageRoot?: string | undefined;
	result: JestResult;
	styles: Styles;
}

/**
 * The single-project report.
 * @param options - Result, format options and run timing.
 * @returns The report text.
 */
export function formatResult({ options, result, timing }: FormatResultOptions): string {
	const styles = createStyles(options.color, options.slowTestThreshold);
	// run/run-header.ts prints the header; this blank line follows it.
	const lines: Array<string> = ["", ...formatFileSummaries({ options, result, styles })];

	const totalDetailedFailures = countDetailedFailures(result);
	if (totalDetailedFailures > 0) {
		const failureCtx: FailureContext = {
			currentIndex: 1,
			totalFailures: totalDetailedFailures,
		};
		lines.push(
			"",
			formatFailedTestsHeader(totalDetailedFailures, { styles }),
			...formatDetailedFailures({ failureCtx, options, result, styles }),
		);
	}

	lines.push(...formatSummaryAndHints({ options, result, styles, timing }));

	return lines.join("\n");
}

/**
 * Render every project's section, then one summary over their merged results.
 * @param options - Projects, format options and run timing.
 * @returns The report text.
 */
export function formatMultiProjectResult({
	options,
	projects,
	timing,
}: FormatMultiProjectResultOptions): string {
	const styles = createStyles(options.color, options.slowTestThreshold);

	const failureCtx: FailureContext = {
		currentIndex: 1,
		totalFailures: projects.reduce((sum, { result }) => sum + countDetailedFailures(result), 0),
	};

	const sections = projects.map(({ displayColor, displayName, gameOutput, result, rootDir }) => {
		return formatProjectSection({
			displayColor,
			displayName,
			failureCtx,
			gameOutput,
			options,
			packageRoot: rootDir,
			result,
			styles,
		});
	});

	// run/run-header.ts prints the header; this blank line follows it.
	const lines: Array<string> = ["", sections.join("\n\n")];

	const mergedResult = mergeJestResults(projects.map((project) => project.result));
	lines.push(...formatSummaryAndHints({ options, result: mergedResult, styles, timing }));

	return lines.join("\n");
}

/**
 * Render type-assertion failures, then the `Tests` and `Type Errors` rows.
 * @param result - Outcome of the type assertions.
 * @param options - Summary-row switch and palette.
 * @returns The report, newline-terminated, or empty.
 */
export function formatTypecheckReport(
	result: JestResult,
	{ includeSummaryRows = true, styles }: TypecheckReportOptions,
): string {
	const failed = result.numFailedTests;

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

function formatFileSummaries({ options, result, styles }: ReportPhaseOptions): Array<string> {
	const lines: Array<string> = [];

	for (const file of result.testResults) {
		if (options.failuresOnly === true && file.numFailingTests === 0 && !hasExecError(file)) {
			continue;
		}

		lines.push(formatFileSummary({ file, options, styles }));
	}

	return lines;
}

function countDetailedFailures(result: JestResult): number {
	return result.numFailedTests + result.testResults.filter(hasExecError).length;
}

function formatDetailedFailures({
	failureCtx,
	options,
	result,
	styles,
}: ReportPhaseOptions & { failureCtx: FailureContext }): Array<string> {
	const lines: Array<string> = [];
	const execErrors = result.testResults.filter(hasExecError);

	for (const file of result.testResults) {
		const failures = formatFileFailures({ failureCtx, file, options, styles });
		if (failures !== "") {
			lines.push(failures);
		}
	}

	for (const file of execErrors) {
		lines.push(
			formatExecErrorDetail({
				failureCtx,
				file,
				rootDir: options.rootDir,
				sourceMapper: options.sourceMapper,
				styles,
			}),
		);
	}

	return lines;
}

function formatSummaryAndHints({
	options,
	result,
	styles,
	timing,
}: ReportPhaseOptions & { timing: TimingResult }): Array<string> {
	const lines: Array<string> = [
		"",
		formatTestSummary({
			affected: options.affected,
			bail: options.bail,
			result,
			snapshotWriteFailures: options.snapshotWriteFailures,
			styles,
			timing,
			typeErrors: options.typeErrors,
		}),
	];

	if (!result.success) {
		const hints = formatLogHints({ options, snapshot: result.snapshot, styles });
		if (hints !== "") {
			lines.push("", hints);
		}
	}

	return lines;
}

function formatProjectHeader({
	displayColor,
	displayName,
	result,
	styles: resolved,
}: ProjectHeaderOptions): string {
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
	const badge = formatProjectBadge({ displayColor, displayName, styles: resolved });

	return `${badge}  ${fileStats} ${meta}`;
}

function formatProjectSection({
	displayColor,
	displayName,
	failureCtx,
	gameOutput,
	options,
	packageRoot,
	result,
	styles: resolved,
}: ProjectSectionOptions): string {
	const lines: Array<string> = [
		formatProjectHeader({
			displayColor,
			displayName,
			result,
			styles: resolved,
		}),
		...formatFileSummaries({ options, result, styles: resolved }),
		...formatDetailedFailures({
			failureCtx,
			options: withPackageRoot(options, packageRoot),
			result,
			styles: resolved,
		}),
	];

	if (!result.success) {
		lines.push(...formatGameOutputBlock(parseGameOutput(gameOutput), resolved));
	}

	return lines.join("\n");
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

function formatTypecheckFailures(result: JestResult, styles: Styles): string {
	const lines: Array<string> = [];

	for (const file of result.testResults) {
		lines.push(...formatTypecheckFileFailures(file, styles));
	}

	return lines.join("\n");
}
