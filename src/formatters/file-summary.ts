import assert from "node:assert";
import path from "node:path";

import {
	hasExecError,
	type JestResult,
	type TestCaseResult,
	type TestFileResult,
} from "../types/jest-result.ts";
import { type FormatOptions, resolveDisplayPath } from "./shared.ts";
import { formatDuration, type Styles } from "./styles.ts";
import { countFileBuckets } from "./summary.ts";

export interface ProjectStats {
	durationMs: number;
	failedFiles: number;
	passedFiles: number;
	skippedFiles: number;
	totalTests: number;
}

/** The one-or-more lines that report a single test file's outcome. */
export function formatFileSummary(
	file: TestFileResult,
	options: FormatOptions,
	styles: Styles,
): string {
	const displayPath = resolveDisplayPath(file.testFilePath, options.sourceMapper);
	const formattedPath = formatFilePath(displayPath, styles);
	const testCount = file.numPassingTests + file.numFailingTests + file.numPendingTests;

	if (file.numFailingTests > 0) {
		return formatFailedFileSummary(file, testCount, styles, displayPath).join("\n");
	}

	if (hasExecError(file)) {
		return formatExecErrorFileSummary(file, formattedPath, styles).join("\n");
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

export function computeProjectStats(result: JestResult): ProjectStats {
	// The file counts come from countFileBuckets rather than a second walk of
	// the same list: the header and the trailing `Test Files` row report the
	// same files, so they answer to one predicate.
	const buckets = countFileBuckets(result);

	let durationMs = 0;
	for (const file of result.testResults) {
		durationMs += sumFileDuration(file);
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

// A group of tests that all skipped has no duration to report, which is not the
// same as a duration of zero — hence the emptiness check rather than `> 0`.
function formatGroupDuration(tests: Array<TestCaseResult>, styles: Styles): string {
	const durations = tests
		.filter((testCase) => countsTowardDuration(testCase))
		.map((testCase) => testCase.duration)
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
	const duration =
		testCase.duration !== undefined ? formatDuration(testCase.duration, styles) : "";
	if (testCase.status === "passed") {
		const marker = styles.status.pass("     ✓");
		// Red title is intentional: this function only runs inside failed suites.
		// The green ✓ already shows the individual test passed — the red reflects
		// the parent suite's failure.
		const title = styles.status.fail(` ${testCase.title}`);
		return `${marker}${title}${duration}`;
	}

	if (testCase.status === "failed") {
		const failedText = `     × ${testCase.title}`;
		return `${styles.status.fail(failedText)}${duration}`;
	}

	// skipped / todo / disabled — duration intentionally suppressed (didn't run)
	const symbol = testCase.status === "todo" ? "□" : "↓";
	return styles.status.pending(`     ${symbol} ${testCase.title}`);
}

function formatDescribeGroup(
	describeName: string,
	tests: Array<TestCaseResult>,
	styles: Styles,
): Array<string> {
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

function formatFailedFileSummary(
	file: TestFileResult,
	testCount: number,
	styles: Styles,
	displayPath: string,
): Array<string> {
	const failedMeta = styles.summary.failed(`${file.numFailingTests} failed`);
	const metaPrefix = styles.dim(`(${testCount} tests | `);
	const metaSuffix = styles.dim(")");
	const meta = `${metaPrefix}${failedMeta}${metaSuffix}`;
	const header = styles.status.fail(` ❯ ${displayPath}`);

	const lines = [`${header} ${meta}`];

	const groups = groupByDescribe(file.testResults);
	for (const [describeName, tests] of groups) {
		lines.push(...formatDescribeGroup(describeName, tests, styles));
	}

	return lines;
}

function formatExecErrorFileSummary(
	file: TestFileResult,
	formattedPath: string,
	styles: Styles,
): Array<string> {
	const symbol = styles.status.fail("✗");
	assert(file.failureMessage !== undefined, "exec error files have failureMessage");
	return [` ${symbol} ${formattedPath}`];
}

function formatPass(test: TestCaseResult, styles: Styles): string {
	const duration = test.duration !== undefined ? formatDuration(test.duration, styles) : "";
	return styles.status.pass(`  ✓ ${test.fullName}`) + duration;
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

function formatPassedFileSummary(
	file: TestFileResult,
	ctx: { formattedPath: string; styles: Styles; testCount: number; verbose: boolean },
): Array<string> {
	const fileMs = sumFileDuration(file);
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
