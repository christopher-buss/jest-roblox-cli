import { hasExecError, type JestResult, type SnapshotSummary } from "../types/jest-result.ts";
import type { TimingResult } from "../types/timing.ts";
import { formatBannerBar } from "../utils/banner.ts";
import { type BailSummary, type FormatOptions, getTerminalWidth } from "./shared.ts";
import { type ColorFunc, createStyles, type Styles } from "./styles.ts";

/** The three buckets a summary row counts, whatever it is counting. */
export interface SummaryCounts {
	failed: number;
	passed: number;
	skipped: number;
}

/**
 * The `Tests` row's numbers. `total` is Jest's `numTotalTests`, which also
 * counts todo tests — no bucket carries those, so it is not the sum of the
 * three, and the row cannot derive it the way the file row can.
 */
export interface TestRowCounts {
	counts: SummaryCounts;
	total: number;
}

export function formatRunHeader(options: FormatOptions, styles?: Styles): string {
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
 */
export function formatTypeErrorsLine(typeErrors: number, styles: Styles): string {
	const typeErrorLabel = styles.dim("Type Errors");
	const typeErrorValue =
		typeErrors > 0 ? styles.summary.failed(`${typeErrors} failed`) : styles.dim("no errors");
	return `${typeErrorLabel}  ${typeErrorValue}`;
}

/** The trailing block of totals: snapshots, files, tests, timings. */
export function formatTestSummary(
	result: JestResult,
	timing: TimingResult,
	styles?: Styles,
	options?: {
		bail?: BailSummary | undefined;
		snapshotWriteFailures?: number | undefined;
		typeErrors?: number | undefined;
	},
): string {
	const st = styles ?? createStyles(true);
	const lines: Array<string> = [
		...collectSnapshotLines(result.snapshot, options?.snapshotWriteFailures ?? 0, st),
		formatTestFilesLine(countFileBuckets(result), st),
		formatTestsLine(countTestBuckets(result), st),
	];

	// Type Errors line (only shown when typecheck was enabled)
	if (options?.typeErrors !== undefined) {
		lines.push(formatTypeErrorsLine(options.typeErrors, st));
	}

	if (options?.bail !== undefined) {
		lines.push(formatBailLine(options.bail, st));
	}

	lines.push(formatStartAtLine(timing.startTime, st), formatDurationLine(timing, st));

	return lines.join("\n");
}

export function formatLogHints(
	options: FormatOptions,
	styles: Styles,
	snapshot?: SnapshotSummary,
): string {
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

function collectSnapshotLines(
	snapshot: SnapshotSummary | undefined,
	writeFailures: number,
	styles: Styles,
): Array<string> {
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
		// `unchecked` is Jest's "obsolete" count — orphaned snapshot keys inside
		// still-present `.snap.luau` files. `filesRemoved` is a separate count
		// (whole files removed); mixing the two units would over-report.
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
 */
export function formatTestsLine({ counts, total }: TestRowCounts, styles: Styles): string {
	return formatCountRow({ counts, label: "      Tests", total }, styles);
}

/** The test-level numbers of one run, paired so no caller can mismatch them. */
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
 */
export function formatTestFilesLine(counts: SummaryCounts, styles: Styles): string {
	const total = counts.failed + counts.passed + counts.skipped;
	return formatCountRow({ counts, label: " Test Files", total }, styles);
}

/**
 * The file-level counts of one run. A file with an exec error is failed even
 * though it reported no failing tests; one that reported neither a failure nor
 * a pass ran nothing, so it is skipped rather than passed.
 */
export function countFileBuckets(result: JestResult): SummaryCounts {
	const execErrorFiles = result.testResults.filter(hasExecError).length;
	const totalFiles = result.testResults.length;
	const failed =
		result.testResults.filter((file) => file.numFailingTests > 0).length + execErrorFiles;
	const skipped = result.testResults.filter(
		(file) => file.numFailingTests === 0 && file.numPassingTests === 0 && !hasExecError(file),
	).length;

	return { failed, passed: totalFiles - failed - skipped, skipped };
}

/**
 * The `     Bailed  …` row, shown when `--bail` cut the run short. Without it
 * the totals read as the whole selection when they are a prefix of it.
 */
export function formatBailLine(bail: BailSummary, styles: Styles): string {
	const reached = `after ${bail.ran} ${bail.ran === 1 ? "package" : "packages"}`;
	const notRun = `, ${bail.notRun} not run`;
	return `${styles.dim("     Bailed")}  ${styles.summary.failed(reached)}${styles.dim(notRun)}`;
}

function formatCountRow(
	{ counts, label, total }: { counts: SummaryCounts; label: string; total: number },
	styles: Styles,
): string {
	const parts = formatSummaryParts(counts, styles);
	const totalLabel = styles.dim(`(${total})`);
	return `${styles.dim(label)}  ${parts.join(" | ")} ${totalLabel}`;
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
	const startAtStr = startDate.toLocaleTimeString("en-GB", { hour12: false });
	return `${styles.dim("   Start at")}  ${startAtStr}`;
}

// `environment` and `cli` are the two residuals — whatever the measured phases
// leave unaccounted for — so both are clamped at zero. `environment` is what
// the execution window has left after the phases inside it; `cli` is what the
// total has left after the window and every phase measured outside it, so a new
// outside-the-window phase belongs in `outsideExecutionMs` as well as in its
// own segment.
function buildDurationBreakdown(timing: TimingResult): Array<string> {
	const setupMs = timing.setupMs ?? 0;
	const environmentMs = Math.max(0, timing.executionMs - timing.testsMs - setupMs);
	const uploadMs = timing.uploadMs ?? 0;
	const coverageMs = timing.coverageMs ?? 0;
	const stagingMs = timing.stagingMs ?? 0;
	const outsideExecutionMs = uploadMs + coverageMs + stagingMs;
	const cliMs = Math.max(0, timing.totalMs - timing.executionMs - outsideExecutionMs);
	const parts: Array<string> = [];

	if (timing.uploadMs !== undefined) {
		parts.push(`upload ${timing.uploadMs}ms`);
	}

	parts.push(`environment ${environmentMs}ms`);

	if (setupMs > 0) {
		parts.push(`setup ${setupMs}ms`);
	}

	parts.push(`tests ${timing.testsMs}ms`, `cli ${cliMs}ms`);

	if (stagingMs > 0) {
		parts.push(`staging ${stagingMs}ms`);
	}

	if (coverageMs > 0) {
		parts.push(`coverage ${coverageMs}ms`);
	}

	return parts;
}

function formatDurationLine(timing: TimingResult, styles: Styles): string {
	const breakdown = styles.dim(`(${buildDurationBreakdown(timing).join(", ")})`);
	return `${styles.dim("   Duration")}  ${timing.totalMs}ms ${breakdown}`;
}
