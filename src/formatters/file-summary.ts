import path from "node:path";

import { formatDuration, type Styles } from "../terminal/palette.ts";
import { hasExecError } from "../types/exec-error-file.ts";
import type { JestResult, TestCaseResult, TestFileResult } from "../types/jest-result-types.ts";
import { countFileBuckets } from "./failure-model.ts";
import { type FormatOptions, resolveDisplayPath } from "./shared.ts";

/**
 * Totals for one project's header line.
 */
export interface ProjectStats {
	/**
	 * Summed duration of the files: each file's host time when it carries one,
	 * else its timed tests' durations.
	 */
	durationMs: number;
	/**
	 * Files counted as failed.
	 */
	failedFiles: number;
	/**
	 * Files counted as passed.
	 */
	passedFiles: number;
	/**
	 * Files counted as skipped.
	 */
	skippedFiles: number;
	/**
	 * Tests in the run.
	 */
	totalTests: number;
}

/**
 * Inputs of `formatFileSummary`.
 */
export interface FormatFileSummaryOptions {
	/**
	 * File to report.
	 */
	file: TestFileResult;
	/**
	 * Format options.
	 */
	options: FormatOptions;
	/**
	 * Palette to render with.
	 */
	styles: Styles;
}

interface FormatFailedFileSummaryOptions {
	displayPath: string;
	file: TestFileResult;
	styles: Styles;
	testCount: number;
}

/**
 * The one-or-more lines that report a single test file's outcome.
 * @param options - File, format options and palette.
 * @returns The file's summary lines joined by newlines.
 */
export function formatFileSummary({ file, options, styles }: FormatFileSummaryOptions): string {
	const displayPath = resolveDisplayPath(file.testFilePath, options);
	const formattedPath = formatFilePath(displayPath, styles);
	const testCount = file.numPassingTests + file.numFailingTests + file.numPendingTests;

	if (file.numFailingTests > 0) {
		return formatFailedFileSummary({ displayPath, file, styles, testCount }).join("\n");
	}

	if (hasExecError(file)) {
		return formatExecErrorFileSummary({ file, formattedPath, styles });
	}

	if (file.numPassingTests === 0 && file.numPendingTests > 0) {
		const symbol = styles.status.pending("↓");
		const meta = styles.dim(`(${testCount} tests)`);
		return ` ${symbol} ${formattedPath} ${meta}`;
	}

	return formatPassedFileSummary(file, {
		formattedPath,
		styles,
		testCount,
		verbose: options.verbose,
	}).join("\n");
}

/**
 * Total a project's files by outcome and its test durations.
 * @param result - Jest result of one project.
 * @returns The project's totals.
 */
export function computeProjectStats(result: JestResult): ProjectStats {
	const buckets = countFileBuckets(result);

	let durationMs = 0;
	for (const file of result.testResults) {
		durationMs += fileDurationMs(file);
	}

	return {
		durationMs,
		failedFiles: buckets.failed,
		passedFiles: buckets.passed,
		skippedFiles: buckets.skipped,
		totalTests: result.numTotalTests,
	};
}

function formatFilePath(filePath: string, styles: Styles): string {
	const directory = path.dirname(filePath);
	const base = path.basename(filePath);
	const directoryWithSlash = styles.path.dir(`${directory}/`);
	const fileName = styles.path.file(base);
	return directory && directory !== "." ? directoryWithSlash + fileName : fileName;
}

function groupByDescribe(tests: Array<TestCaseResult>): Map<string, Array<TestCaseResult>> {
	const groups = new Map<string, Array<TestCaseResult>>();

	for (const test of tests) {
		const describeName = test.ancestorTitles[0] ?? "(root)";
		const group = groups.get(describeName);
		if (group !== undefined) {
			group.push(test);
		} else {
			groups.set(describeName, [test]);
		}
	}

	return groups;
}

function countsTowardDuration(test: TestCaseResult): boolean {
	return test.status === "passed" || test.status === "failed";
}

function testDurationMs(test: TestCaseResult): number | undefined {
	return test.duration;
}

function formatGroupDuration(tests: Array<TestCaseResult>, styles: Styles): string {
	const durations = tests
		.filter((testCase) => countsTowardDuration(testCase))
		.map((testCase) => testDurationMs(testCase))
		.filter((duration) => duration !== undefined);
	if (durations.length === 0) {
		return "";
	}

	return formatDuration(
		durations.reduce((sum, duration) => sum + duration, 0),
		styles,
	);
}

function formatTestInGroup(testCase: TestCaseResult, styles: Styles): string {
	const durationMs = testDurationMs(testCase);
	const duration = durationMs !== undefined ? formatDuration(durationMs, styles) : "";
	if (testCase.status === "passed") {
		const marker = styles.status.pass("     ✓");
		const title = styles.status.fail(` ${testCase.title}`);
		return `${marker}${title}${duration}`;
	}

	if (testCase.status === "failed") {
		const failedText = `     × ${testCase.title}`;
		return `${styles.status.fail(failedText)}${duration}`;
	}

	const symbol = testCase.status === "todo" ? "□" : "↓";
	return styles.status.pending(`     ${symbol} ${testCase.title}`);
}

function formatDescribeGroup({
	describeName,
	styles,
	tests,
}: {
	describeName: string;
	styles: Styles;
	tests: Array<TestCaseResult>;
}): Array<string> {
	const groupTestCount = tests.length;
	const groupDurationStr = formatGroupDuration(tests, styles);
	const failedCount = tests.filter((testCase) => testCase.status === "failed").length;

	if (failedCount === 0) {
		const groupMeta = styles.dim(`(${groupTestCount} tests)`);
		const marker = styles.status.pass("   ✓");
		const name = styles.status.fail(` ${describeName}`);
		return [`${marker}${name} ${groupMeta}${groupDurationStr}`];
	}

	const groupMeta =
		styles.dim(`(${groupTestCount} tests | `) +
		styles.summary.failed(`${failedCount} failed`) +
		styles.dim(")");
	const header = styles.status.fail(`   ❯ ${describeName}`);

	return [
		`${header} ${groupMeta}${groupDurationStr}`,
		...tests.map((testCase) => formatTestInGroup(testCase, styles)),
	];
}

function formatFailedFileSummary({
	displayPath,
	file,
	styles,
	testCount,
}: FormatFailedFileSummaryOptions): Array<string> {
	const failedMeta = styles.summary.failed(`${file.numFailingTests} failed`);
	const metaPrefix = styles.dim(`(${testCount} tests | `);
	const metaSuffix = styles.dim(")");
	const meta = `${metaPrefix}${failedMeta}${metaSuffix}`;
	const header = styles.status.fail(` ❯ ${displayPath}`);

	const lines = [`${header} ${meta}`];

	const groups = groupByDescribe(file.testResults);
	for (const [describeName, tests] of groups) {
		lines.push(...formatDescribeGroup({ describeName, styles, tests }));
	}

	return lines;
}

function formatExecErrorFileSummary({
	file,
	formattedPath,
	styles,
}: {
	file: TestFileResult;
	formattedPath: string;
	styles: Styles;
}): string {
	const symbol = file.timedOut === true ? styles.status.pending("⏱") : styles.status.fail("✗");
	return ` ${symbol} ${formattedPath}`;
}

function sumFileDuration(file: TestFileResult): number {
	let total = 0;
	for (const test of file.testResults) {
		if (test.duration !== undefined && countsTowardDuration(test)) {
			total += test.duration;
		}
	}

	return total;
}

function fileDurationMs(file: TestFileResult): number {
	return sumFileDuration(file);
}

function formatPass(test: TestCaseResult, styles: Styles): string {
	const durationMs = testDurationMs(test);
	const duration = durationMs !== undefined ? formatDuration(durationMs, styles) : "";
	return styles.status.pass(`  ✓ ${test.fullName}`) + duration;
}

function formatPassedFileSummary(
	file: TestFileResult,
	ctx: { formattedPath: string; styles: Styles; testCount: number; verbose: boolean },
): Array<string> {
	const fileMs = fileDurationMs(file);
	const symbol = ctx.styles.status.pass("✓");
	const testsLabel = ctx.styles.dim(`(${ctx.testCount} tests`);
	const closeParen = ctx.styles.dim(")");
	const duration =
		fileMs > 0 ? `${ctx.styles.dim(" -")}${formatDuration(fileMs, ctx.styles)}` : "";
	const lines = [` ${symbol} ${ctx.formattedPath} ${testsLabel}${duration}${closeParen}`];

	if (ctx.verbose) {
		for (const testCase of file.testResults) {
			if (testCase.status === "passed") {
				lines.push(formatPass(testCase, ctx.styles));
			}
		}
	}

	return lines;
}
