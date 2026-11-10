import { buildDurationBreakdown } from "../host-time/duration-breakdown.ts";
import type { ColorFunc, Styles } from "../terminal/palette.ts";
import { plural } from "../terminal/plural.ts";
import type { BailSummary } from "../types/bail-summary-types.ts";
import type { JestResult, SnapshotSummary } from "../types/jest-result-types.ts";
import type { TimingResult } from "../types/timing-types.ts";
import { countFileBuckets, formatLogHintLines, type SummaryCounts } from "./failure-model.ts";
import type { AffectedSummary, FormatOptions, PartialRunCause } from "./shared.ts";

/**
 * The `Tests` row's numbers; `total` also counts todo tests.
 */
export interface TestRowCounts {
	/**
	 * Failed, passed and skipped tests.
	 */
	counts: SummaryCounts;
	/**
	 * Jest's `numTotalTests`.
	 */
	total: number;
}

/**
 * Inputs of `formatTestSummary`.
 */
export interface TestSummaryOptions {
	/**
	 * Adds the Affected row when set.
	 */
	affected?: AffectedSummary | undefined;
	/**
	 * Adds the Bailed row when set.
	 */
	bail?: BailSummary | undefined;
	/**
	 * Result to total.
	 */
	result: JestResult;
	/**
	 * Snapshots that failed to write; defaults to 0.
	 */
	snapshotWriteFailures?: number | undefined;
	/**
	 * Palette to render with.
	 */
	styles: Styles;
	/**
	 * Run timing for the Start at and Duration rows.
	 */
	timing: TimingResult;
	/**
	 * Type errors found; adds the Type Errors row when set.
	 */
	typeErrors?: number | undefined;
}

/**
 * Inputs of `formatLogHints`.
 */
export interface FormatLogHintsOptions {
	/**
	 * Format options naming the written output files.
	 */
	options: FormatOptions;
	/**
	 * Snapshot totals; unmatched snapshots add the update hint.
	 */
	snapshot?: SnapshotSummary | undefined;
	/**
	 * Palette to render with.
	 */
	styles: Styles;
}

/**
 * Render the RUN header with the version, root and coverage line.
 * @param options - Version, root and coverage switch.
 * @param st - Palette to render with.
 * @returns The newline-wrapped header.
 */
export function formatRunHeader(
	options: Pick<FormatOptions, "collectCoverage" | "rootDir" | "version">,
	st: Styles,
): string {
	const runBadge = st.runBadge(" RUN ");
	const version = st.location(`v${options.version}`);
	const rootDirectory = st.lineNumber(options.rootDir);
	const header = `\n${runBadge} ${version} ${rootDirectory}`;

	if (options.collectCoverage === true) {
		const subtitle = `${st.dim("      Coverage enabled with")} ${st.status.pending("istanbul")}`;
		return `${header}\n${subtitle}\n`;
	}

	return `${header}\n`;
}

/**
 * The `Type Errors  …` row; matches vitest's typecheck summary byte for byte.
 * @param typeErrors - Type errors found.
 * @param styles - Palette to render with.
 * @returns The row.
 */
export function formatTypeErrorsLine(typeErrors: number, styles: Styles): string {
	const typeErrorLabel = styles.dim("Type Errors");
	const typeErrorValue =
		typeErrors > 0 ? styles.summary.failed(`${typeErrors} failed`) : styles.dim("no errors");
	return `${typeErrorLabel}  ${typeErrorValue}`;
}

/**
 * The trailing block of totals: snapshots, files, tests, timings.
 * @param options - Result, timing, optional counts and palette.
 * @returns The block's rows joined by newlines.
 */
export function formatTestSummary({
	affected,
	bail,
	result,
	snapshotWriteFailures = 0,
	styles: st,
	timing,
	typeErrors,
}: TestSummaryOptions): string {
	const lines: Array<string> = [
		...collectSnapshotLines({
			snapshot: result.snapshot,
			styles: st,
			writeFailures: snapshotWriteFailures,
		}),
		formatTestFilesLine(countFileBuckets(result), st),
		...(affected === undefined ? [] : [formatAffectedLine(affected, st)]),
		formatTestsLine(countTestBuckets(result), st),
	];

	if (typeErrors !== undefined) {
		lines.push(formatTypeErrorsLine(typeErrors, st));
	}

	if (bail !== undefined) {
		lines.push(formatBailLine(bail, st));
	}

	lines.push(formatStartAtLine(timing.startTime, st), formatDurationLine(timing, st));

	return lines.join("\n");
}

/**
 * Render the snapshot update and output-file hints of a failed run.
 * @param options - Format options, snapshot totals and palette.
 * @returns The hint lines, or empty when none apply.
 */
export function formatLogHints({ options, snapshot, styles }: FormatLogHintsOptions): string {
	const lines: Array<string> = [];

	if (snapshot !== undefined && snapshot.unmatched > 0) {
		lines.push(
			styles.dim("  Inspect your code changes or rerun with `-u` to update snapshots."),
		);
	}

	const hints = formatLogHintLines({
		gameOutput: options.gameOutput,
		outputFile: options.outputFile,
	});
	for (const hint of hints) {
		lines.push(styles.dim(`  ${hint}`));
	}

	return lines.join("\n");
}

function formatSnapshotWriteFailureLine(failures: number, styles: Styles): string | undefined {
	if (failures <= 0) {
		return undefined;
	}

	const label = styles.dim("  Snapshot Write");
	const failed = styles.summary.failed(`${failures} failed`);
	return `${label}  ${failed}`;
}

function collectSnapshotLines({
	snapshot,
	styles,
	writeFailures,
}: {
	snapshot: SnapshotSummary | undefined;
	styles: Styles;
	writeFailures: number;
}): Array<string> {
	const lines: Array<string> = [];

	const writeFailureLine = formatSnapshotWriteFailureLine(writeFailures, styles);
	if (writeFailureLine !== undefined) {
		lines.push(writeFailureLine);
	}

	const snapshotLine = formatSnapshotLine(snapshot, styles);
	if (snapshotLine !== undefined) {
		lines.push(snapshotLine);
	}

	return lines;
}

const SNAPSHOT_COUNTS: Array<{
	count: (snapshot: SnapshotSummary) => number;
	label: string;
	tone: (styles: Styles) => ColorFunc;
}> = [
	{
		count: (snapshot) => snapshot.unmatched,
		label: "failed",
		tone: (styles) => styles.summary.failed,
	},
	{
		count: (snapshot) => snapshot.unchecked ?? 0,
		label: "obsolete",
		tone: (styles) => styles.summary.pending,
	},
	{
		count: (snapshot) => snapshot.updated,
		label: "updated",
		tone: (styles) => styles.summary.passed,
	},
	{
		count: (snapshot) => snapshot.added,
		label: "written",
		tone: (styles) => styles.summary.passed,
	},
	{
		count: (snapshot) => snapshot.matched,
		label: "passed",
		tone: (styles) => styles.summary.passed,
	},
];

/**
 * The non-zero buckets of a summary row, in vitest's `getStateString` order.
 * @param counts - Bucket counts.
 * @param styles - Palette to render with.
 * @returns The non-zero buckets, styled.
 */
export function formatSummaryParts(counts: SummaryCounts, styles: Styles): Array<string> {
	const parts: Array<string> = [];
	if (counts.failed > 0) {
		parts.push(styles.summary.failed(`${counts.failed} failed`));
	}

	if (counts.passed > 0) {
		parts.push(styles.summary.passed(`${counts.passed} passed`));
	}

	if (counts.skipped > 0) {
		parts.push(styles.summary.pending(`${counts.skipped} skipped`));
	}

	return parts;
}

/**
 * The `      Tests  …` row.
 * @param counts - Test buckets and Jest's total.
 * @param styles - Palette to render with.
 * @returns The row.
 */
export function formatTestsLine({ counts, total }: TestRowCounts, styles: Styles): string {
	return formatCountRow({ counts, label: "      Tests", total }, styles);
}

/**
 * The test-level numbers of one run.
 * @param result - Run result.
 * @returns The test buckets and Jest's total.
 */
export function countTestBuckets(result: JestResult): TestRowCounts {
	return {
		counts: {
			failed: result.numFailedTests,
			passed: result.numPassedTests,
			skipped: result.numPendingTests,
		},
		total: result.numTotalTests,
	};
}

/**
 * The ` Test Files  …` row.
 * @param counts - File buckets.
 * @param styles - Palette to render with.
 * @returns The row.
 */
export function formatTestFilesLine(counts: SummaryCounts, styles: Styles): string {
	const total = counts.failed + counts.passed + counts.skipped;
	return formatCountRow({ counts, label: " Test Files", total }, styles);
}

/**
 * The `     Bailed  …` row, shown when `--bail` cut the run short.
 * @param bail - Packages reached and not run.
 * @param styles - Palette to render with.
 * @returns The row.
 */
export function formatBailLine(bail: BailSummary, styles: Styles): string {
	const reached = `after ${bail.ran} ${plural(bail.ran, "package")}`;
	const notRun = `, ${bail.notRun} not run`;
	return `${styles.dim("     Bailed")}  ${styles.summary.failed(reached)}${styles.dim(notRun)}`;
}

/**
 * The `   Affected  …` row of a Partial Run, as vitest prints it after
 * `Test Files`: the selected and total test files, then what they relate to.
 * @param affected - Selected and total test files, and what they relate to.
 * @param styles - Palette to render with.
 * @returns The row.
 */
export function formatAffectedLine(
	{ affected, cause, total }: AffectedSummary,
	styles: Styles,
): string {
	const relation = styles.dim(`(${describeCause(cause)})`);
	return `${styles.dim("   Affected")}  ${affected} of ${total} test files ${relation}`;
}

function formatCountRow(
	{ counts, label, total }: { counts: SummaryCounts; label: string; total: number },
	styles: Styles,
): string {
	const parts = formatSummaryParts(counts, styles);
	const totalLabel = styles.dim(`(${total})`);
	return `${styles.dim(label)}  ${parts.join(" | ")} ${totalLabel}`;
}

function describeCause(cause: PartialRunCause): string {
	if (cause.kind === "changed") {
		return `changed since ${cause.since}`;
	}

	const [first, ...rest] = cause.files;
	const sources =
		first !== undefined && rest.length === 0 ? first : `${cause.files.length} files`;
	return `related to ${sources}`;
}

function formatSnapshotLine(
	snapshot: SnapshotSummary | undefined,
	styles: Styles,
): string | undefined {
	if (snapshot === undefined) {
		return undefined;
	}

	const parts: Array<string> = [];
	for (const { count, label, tone } of SNAPSHOT_COUNTS) {
		const value = count(snapshot);
		if (value > 0) {
			parts.push(tone(styles)(`${value} ${label}`));
		}
	}

	if (parts.length === 0) {
		return undefined;
	}

	const label = styles.dim("  Snapshots");
	const totalLabel = styles.dim(`(${snapshot.total})`);

	return `${label}  ${parts.join(" | ")} ${totalLabel}`;
}

function formatStartAtLine(startTime: number, styles: Styles): string {
	const startDate = new Date(startTime);
	const startAtStr = startDate.toLocaleTimeString("en-GB");
	return `${styles.dim("   Start at")}  ${startAtStr}`;
}

function formatDurationLine(timing: TimingResult, styles: Styles): string {
	const parts = buildDurationBreakdown(timing, {
		residual: "environment",
		work: "tests",
		workMs: timing.testsMs,
	});
	const breakdown = styles.dim(`(${parts.join(", ")})`);
	return `${styles.dim("   Duration")}  ${timing.totalMs}ms ${breakdown}`;
}
