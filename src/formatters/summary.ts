import { hasExecError } from "../types/exec-error-file.ts";
import type { JestResult, SnapshotSummary } from "../types/jest-result-types.ts";
import type { TimingResult } from "../types/timing-types.ts";
import { formatBannerBar } from "../utils/banner.ts";
import { buildDurationBreakdown } from "./duration-breakdown.ts";
import {
	type AffectedSummary,
	type BailSummary,
	type FormatOptions,
	getTerminalWidth,
	type PartialRunCause,
} from "./shared.ts";
import { type ColorFunc, createStyles, type Styles } from "./styles.ts";

/** The three buckets a summary row counts, whatever it is counting. */
export interface SummaryCounts {
	/**
	 * Files or tests that failed.
	 */
	failed: number;
	/**
	 * Files or tests that passed.
	 */
	passed: number;
	/**
	 * Files or tests that were skipped.
	 */
	skipped: number;
}

/**
 * The `Tests` row's numbers. `total` is Jest's `numTotalTests`, which also
 * counts todo tests — no bucket carries those, so it is not the sum of the
 * three, and the row cannot derive it the way the file row can.
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
	 * Palette to render with; colored when absent.
	 */
	styles?: Styles | undefined;
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
 * Render the RUN header with the version and root, plus a coverage line when coverage is on.
 * @param options - Version, root, color and coverage switch.
 * @param styles - Palette to render with; built from `options.color` when absent.
 * @returns The newline-wrapped header.
 */
export function formatRunHeader(
	options: Pick<FormatOptions, "collectCoverage" | "color" | "rootDir" | "version">,
	styles?: Styles,
): string {
	const st = styles ?? createStyles(options.color);
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
 * Render the terminal-wide `Failed Tests N` banner.
 * @param failCount - Failures shown in the title.
 * @param _styles - Unused.
 * @returns The banner.
 */
export function formatFailedTestsHeader(failCount: number, _styles?: Styles): string {
	return formatBannerBar({
		level: "error",
		termWidth: getTerminalWidth(),
		title: `Failed Tests ${failCount}`,
	});
}

/**
 * The `Type Errors  …` row, byte-for-byte vitest's typecheck summary line:
 * an 11-column right-aligned label, two spaces, then a bold-red `N failed` or a
 * dim `no errors`. Shared with the agent formatter so both reporters agree.
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
	styles,
	timing,
	typeErrors,
}: TestSummaryOptions): string {
	const st = styles ?? createStyles(true);
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

	// Type Errors line (only shown when typecheck was enabled)
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
 * Render the hints after a failed run: the snapshot update hint and where the written outputs are.
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

	if (options.outputFile !== undefined) {
		lines.push(styles.dim(`  View ${options.outputFile} for full Jest output`));
	}

	if (options.gameOutput !== undefined) {
		lines.push(styles.dim(`  View ${options.gameOutput} for Roblox game logs`));
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
	/**
	 * Palette to render with.
	 */
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
		/**
		 * `unchecked` is Jest's "obsolete" count — orphaned snapshot keys inside
		 * still-present `.snap.luau` files. `filesRemoved` is a separate count
		 * (whole files removed); mixing the two units would over-report.
		 * @param snapshot - Snapshot totals.
		 * @returns The obsolete count, 0 when Jest omits it.
		 */
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
 * The bucket list a summary row joins with ` | `, in vitest's order: its
 * `getStateString` puts failed first, then passed, then skipped. Each bucket is
 * omitted when zero, so a clean run reads `2 passed (2)` rather than carrying
 * two empty counts.
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
 * The `      Tests  …` row: the counts vitest reports for every run, type
 * pass included.
 * @param counts - Test buckets and Jest's total.
 * @param styles - Palette to render with.
 * @returns The row.
 */
export function formatTestsLine({ counts, total }: TestRowCounts, styles: Styles): string {
	return formatCountRow({ counts, label: "      Tests", total }, styles);
}

/**
 * The test-level numbers of one run, paired so no caller can mismatch them.
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
 * The ` Test Files  …` row. Every file lands in exactly one bucket, so the
 * total is the sum and the caller has nothing else to pass.
 * @param counts - File buckets.
 * @param styles - Palette to render with.
 * @returns The row.
 */
export function formatTestFilesLine(counts: SummaryCounts, styles: Styles): string {
	const total = counts.failed + counts.passed + counts.skipped;
	return formatCountRow({ counts, label: " Test Files", total }, styles);
}

/**
 * The file-level counts of one run, and the one rule for which bucket a file
 * falls in — the `▶ <project>  …` header counts through here too, so a single
 * report cannot call the same file two different things.
 *
 * A file with an exec error is failed even though it reported no failing tests.
 * Past that it follows vitest, which buckets a file on its own mode rather than
 * on a tally of what ran inside it: `skipped` is vitest's `mode: "skip"`, which
 * it sets only when a file has tasks and every one of them is skipped. A file
 * that collected nothing keeps `mode: "run"` and passes, so it does here too.
 * @param result - Jest result whose files to bucket.
 * @returns How many files failed, passed and skipped.
 */
export function countFileBuckets(result: JestResult): SummaryCounts {
	let failed = 0;
	let skipped = 0;

	for (const file of result.testResults) {
		if (file.numFailingTests > 0 || hasExecError(file)) {
			failed++;
		} else if (file.numPassingTests === 0 && file.numPendingTests > 0) {
			skipped++;
		}
	}

	return { failed, passed: result.testResults.length - failed - skipped, skipped };
}

/**
 * The `     Bailed  …` row, shown when `--bail` cut the run short. Without it
 * the totals read as the whole selection when they are a prefix of it.
 * @param bail - Packages reached and not run.
 * @param styles - Palette to render with.
 * @returns The row.
 */
export function formatBailLine(bail: BailSummary, styles: Styles): string {
	const reached = `after ${bail.ran} ${bail.ran === 1 ? "package" : "packages"}`;
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

	// No counted activity at all means there is nothing worth a Snapshots line.
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
