import { hasExecError, type JestResult, type SnapshotSummary } from "../types/jest-result.ts";
import type { TimingResult } from "../types/timing.ts";
import { formatBannerBar } from "../utils/banner.ts";
import { type FormatOptions, getTerminalWidth } from "./shared.ts";
import { type ColorFunc, createStyles, type Styles } from "./styles.ts";

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

/** The trailing block of totals: snapshots, files, tests, timings. */
export function formatTestSummary(
	result: JestResult,
	timing: TimingResult,
	styles?: Styles,
	options?: { snapshotWriteFailures?: number | undefined; typeErrors?: number | undefined },
): string {
	const st = styles ?? createStyles(true);
	const lines: Array<string> = [
		...collectSnapshotLines(result.snapshot, options?.snapshotWriteFailures ?? 0, st),
		formatTestFilesLine(result, st),
		formatTestsLine(result, st),
	];

	// Type Errors line (only shown when typecheck was enabled)
	if (options?.typeErrors !== undefined) {
		lines.push(formatTypeErrorsLine(options.typeErrors, st));
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

function formatSummaryParts(
	counts: { failed: number; passed: number; skipped: number },
	styles: Styles,
): Array<string> {
	const parts: Array<string> = [];
	if (counts.passed > 0) {
		parts.push(styles.summary.passed(`${counts.passed} passed`));
	}

	if (counts.failed > 0) {
		parts.push(styles.summary.failed(`${counts.failed} failed`));
	}

	if (counts.skipped > 0) {
		parts.push(styles.summary.pending(`${counts.skipped} skipped`));
	}

	return parts;
}

function formatTestFilesLine(result: JestResult, styles: Styles): string {
	const execErrorFiles = result.testResults.filter(hasExecError).length;
	const totalFiles = result.testResults.length;
	const failedFiles =
		result.testResults.filter((file) => file.numFailingTests > 0).length + execErrorFiles;
	const skippedFiles = result.testResults.filter(
		(file) => file.numFailingTests === 0 && file.numPassingTests === 0 && !hasExecError(file),
	).length;
	const passedFiles = totalFiles - failedFiles - skippedFiles;

	const fileParts = formatSummaryParts(
		{ failed: failedFiles, passed: passedFiles, skipped: skippedFiles },
		styles,
	);
	const fileTotalLabel = styles.dim(`(${totalFiles})`);

	return `${styles.dim(" Test Files")}  ${fileParts.join(" | ")} ${fileTotalLabel}`;
}

function formatTestsLine(result: JestResult, styles: Styles): string {
	const testParts = formatSummaryParts(
		{
			failed: result.numFailedTests,
			passed: result.numPassedTests,
			skipped: result.numPendingTests,
		},
		styles,
	);
	const testTotalLabel = styles.dim(`(${result.numTotalTests})`);

	return `${styles.dim("      Tests")}  ${testParts.join(" | ")} ${testTotalLabel}`;
}

function formatTypeErrorsLine(typeErrors: number, styles: Styles): string {
	const typeErrorLabel = styles.dim("Type Errors");
	const typeErrorValue =
		typeErrors > 0 ? styles.summary.failed(`${typeErrors} failed`) : styles.dim("no errors");
	return `${typeErrorLabel}  ${typeErrorValue}`;
}

function formatStartAtLine(startTime: number, styles: Styles): string {
	const startDate = new Date(startTime);
	const startAtStr = startDate.toLocaleTimeString("en-GB", { hour12: false });
	return `${styles.dim("   Start at")}  ${startAtStr}`;
}

// `environment` and `cli` are the two residuals — whatever the measured phases
// leave unaccounted for — so both are clamped at zero.
function buildDurationBreakdown(timing: TimingResult): Array<string> {
	const setupMs = timing.setupMs ?? 0;
	const environmentMs = Math.max(0, timing.executionMs - timing.testsMs - setupMs);
	const uploadMs = timing.uploadMs ?? 0;
	const coverageMs = timing.coverageMs ?? 0;
	const cliMs = Math.max(0, timing.totalMs - uploadMs - timing.executionMs - coverageMs);
	const parts: Array<string> = [];

	if (timing.uploadMs !== undefined) {
		parts.push(`upload ${timing.uploadMs}ms`);
	}

	parts.push(`environment ${environmentMs}ms`);

	if (setupMs > 0) {
		parts.push(`setup ${setupMs}ms`);
	}

	parts.push(`tests ${timing.testsMs}ms`, `cli ${cliMs}ms`);

	if (coverageMs > 0) {
		parts.push(`coverage ${coverageMs}ms`);
	}

	return parts;
}

function formatDurationLine(timing: TimingResult, styles: Styles): string {
	const breakdown = styles.dim(`(${buildDurationBreakdown(timing).join(", ")})`);
	return `${styles.dim("   Duration")}  ${timing.totalMs}ms ${breakdown}`;
}
