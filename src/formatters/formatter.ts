import assert from "node:assert";
import * as fs from "node:fs";
import path from "node:path";
import process from "node:process";
import color from "tinyrainbow";

import {
	getSourceSnippet,
	type MappedLocation,
	type SourceMapper,
	type SourceSnippet,
} from "../source-mapper/index.ts";
import {
	hasExecError,
	type JestResult,
	type SnapshotSummary,
	type TestCaseResult,
	type TestFileResult,
} from "../types/jest-result.ts";
import type { TimingResult } from "../types/timing.ts";
import { formatBannerBar } from "../utils/banner.ts";
import { highlightCode } from "../utils/colors.ts";

const EXEC_ERROR_HINTS: Array<[pattern: RegExp, hint: string]> = [
	[
		/loadstring\(\) is not available/,
		'loadstring() must be enabled for Jest to run. Add to your project.json:\n\n  "ServerScriptService": {\n    "$properties": {\n      "LoadStringEnabled": true\n    }\n  }',
	],
];

export interface FormatOptions {
	collectCoverage?: boolean;
	color: boolean;
	failuresOnly?: boolean;
	gameOutput?: string;
	outputFile?: string;
	rootDir: string;
	showLuau?: boolean;
	sourceMapper?: SourceMapper;
	typeErrors?: number;
	verbose: boolean;
	version: string;
}

export interface ParsedError {
	expected?: string;
	message: string;
	received?: string;
	snapshotDiff?: string;
}

export interface SourceLocation {
	column?: number;
	line: number;
	path: string;
}

export interface FormatterProjectEntry {
	displayColor?: string;
	displayName: string;
	result: JestResult;
}

export interface ProjectSectionOptions {
	displayColor?: string;
	displayName: string;
	failureCtx: FailureContext;
	options: FormatOptions;
	result: JestResult;
	styles?: Styles;
}

interface FailureContext {
	currentIndex: number;
	totalFailures: number;
}

type ColorFunc = (text: string) => string;

interface Styles {
	diff: {
		expected: ColorFunc;
		received: ColorFunc;
	};
	dim: ColorFunc;
	failBadge: ColorFunc;
	lineNumber: ColorFunc;
	location: ColorFunc;
	path: {
		dir: ColorFunc;
		file: ColorFunc;
	};
	runBadge: ColorFunc;
	status: {
		fail: ColorFunc;
		pass: ColorFunc;
		pending: ColorFunc;
	};
	summary: {
		failed: ColorFunc;
		passed: ColorFunc;
		pending: ColorFunc;
	};
}

export function getExecErrorHint(message: string): string | undefined {
	for (const [pattern, hint] of EXEC_ERROR_HINTS) {
		if (pattern.test(message)) {
			return hint;
		}
	}

	return undefined;
}

export function formatFailedTestsHeader(failCount: number, _styles?: Styles): string {
	return formatBannerBar({
		level: "error",
		termWidth: getTerminalWidth(),
		title: `Failed Tests ${failCount}`,
	});
}

export function parseErrorMessage(message: string): ParsedError {
	const lines = message.split("\n");
	const firstLine = lines[0];
	assert(firstLine !== undefined, "split always returns ≥1 element");

	const snapshotHeaderIndex = lines.findIndex((line) => /^- Snapshot\s+- \d+/.test(line));
	if (snapshotHeaderIndex !== -1) {
		const diffLines: Array<string> = [];
		for (let index = snapshotHeaderIndex; index < lines.length; index++) {
			// eslint-disable-next-line ts/no-non-null-assertion -- Loop condition
			const line = lines[index]!;
			if (line.startsWith("[string ")) {
				break;
			}

			diffLines.push(line);
		}

		return {
			message: firstLine,
			snapshotDiff: diffLines.join("\n").trimEnd(),
		};
	}

	const expectedMatch = message.match(/Expected\b.*?:\s*(.+)/);
	const receivedMatch = message.match(/Received\b.*?:\s*(.+)/);
	return {
		expected: expectedMatch?.[1],
		message: firstLine,
		received: receivedMatch?.[1],
	};
}

/**
 * Extracts the meaningful error message from a Jest `failureMessage` string.
 * Strips the "● Test suite failed to run" header, Roblox DataModel path chains,
 * and stack trace lines.
 */
export function cleanExecErrorMessage(raw: string): string {
	if (raw === "") {
		return "";
	}

	const lines = raw.split("\n");

	// Find the first content line after the "● Test suite failed to run" header
	let contentLine: string | undefined;
	let pastHeader = false;
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("\u25cf")) {
			pastHeader = true;
			continue;
		}

		if (pastHeader && trimmed !== "") {
			contentLine = trimmed;
			break;
		}
	}

	if (contentLine === undefined) {
		return raw.trim();
	}

	// Strip chained Roblox path prefixes: "Path:123: Path:456: actual message"
	const robloxPathChain = /^(?:[A-Za-z][\w.@-]*:\d+:\s*)+/;
	return contentLine.replace(robloxPathChain, "");
}

export function formatSourceSnippet(
	snippet: SourceSnippet,
	filePath: string,
	options?: { language?: string; styles?: Styles; useColor?: boolean },
): string {
	const useColor = options?.useColor ?? true;
	const styles = options?.styles ?? createStyles(useColor);
	const language = options?.language;
	const lines: Array<string> = [];
	const indent = "\t";

	// Location header: ❯ path:line:col  (Language)
	const location =
		snippet.column !== undefined
			? `${filePath}:${snippet.failureLine}:${snippet.column}`
			: `${filePath}:${snippet.failureLine}`;
	const langSuffix = language !== undefined ? styles.dim(`  (${language})`) : "";
	lines.push(styles.location(` ❯ ${location}`) + langSuffix);

	// Determine padding for line numbers
	const maxLineNumber = Math.max(...snippet.lines.map((line) => line.num));
	const padding = String(maxLineNumber).length;

	for (const line of snippet.lines) {
		const lineNumber = String(line.num).padStart(padding);
		const prefix = `${lineNumber}|`;
		const expandedContent = expandTabs(line.content);
		const highlighted = highlightSyntax(filePath, expandedContent, useColor);

		if (line.num === snippet.failureLine) {
			lines.push(`${indent}${styles.lineNumber(prefix)} ${highlighted}`);

			// Add caret line if column is specified
			if (snippet.column !== undefined) {
				const beforeColumn = expandTabs(line.content.slice(0, snippet.column - 1));
				const caretGutter = `${" ".repeat(padding)}|`;
				const gutterPrefix = styles.lineNumber(caretGutter);
				lines.push(
					`${indent}${gutterPrefix} ${" ".repeat(beforeColumn.length)}${styles.status.fail("^")}`,
				);
			}
		} else {
			lines.push(`${indent}${styles.lineNumber(prefix)} ${highlighted}`);
		}
	}

	return lines.join("\n");
}

export function parseSourceLocation(message: string): SourceLocation | undefined {
	// Match patterns like "path/to/file.ts:25" or "path/to/file.ts:25:12"
	const match = message.match(/([^\s:]+\.(?:tsx?|luau?)):(\d+)(?::(\d+))?/);
	if (match === null) {
		return undefined;
	}

	const [, filePath, lineStr, columnStr] = match;
	assert(filePath !== undefined, "regex group 1 matched");
	assert(lineStr !== undefined, "regex group 2 matched");

	return {
		column: columnStr !== undefined ? Number.parseInt(columnStr, 10) : undefined,
		line: Number.parseInt(lineStr, 10),
		path: filePath,
	};
}

export function resolveDisplayPath(testFilePath: string, sourceMapper?: SourceMapper): string {
	return sourceMapper?.resolveTestFilePath(testFilePath) ?? testFilePath;
}

export function formatFailure({
	failureIndex,
	filePath,
	showLuau = false,
	sourceMapper,
	styles,
	test,
	totalFailures,
	useColor = true,
}: {
	failureIndex?: number;
	filePath?: string;
	showLuau?: boolean;
	sourceMapper?: SourceMapper;
	styles?: Styles;
	test: TestCaseResult;
	totalFailures?: number;
	useColor?: boolean;
}): string {
	const st = styles ?? createStyles(useColor);
	const lines: Array<string> = [];

	// Build test path: file > ancestors > title
	const pathParts = filePath !== undefined ? [filePath] : [];
	pathParts.push(...test.ancestorTitles, test.title);
	const testPath = pathParts.join(" > ");

	// FAIL badge + test path (blank line before for spacing after
	// header/previous failure)
	lines.push("", `${st.failBadge(" FAIL ")} ${st.status.fail(testPath)}`);

	for (const originalMessage of test.failureMessages) {
		lines.push(
			...formatFailureMessage(originalMessage, {
				filePath,
				showLuau,
				sourceMapper,
				styles: st,
				useColor,
			}),
		);
	}

	// Add footer separator with index
	if (failureIndex !== undefined && totalFailures !== undefined) {
		const counter = `[${failureIndex}/${totalFailures}]`;
		const termWidth = getTerminalWidth();
		const fillWidth = Math.max(1, termWidth - counter.length - 3);
		lines.push("", st.dim(st.status.fail(`${"⎯".repeat(fillWidth)}${counter}⎯`)));
	}

	// Indent all lines
	return lines.map((line) => `  ${line}`).join("\n");
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

export function formatTestSummary(
	result: JestResult,
	timing: TimingResult,
	styles?: Styles,
	options?: { typeErrors?: number },
): string {
	const st = styles ?? createStyles(true);
	const lines: Array<string> = [];
	const execErrorFiles = result.testResults.filter(hasExecError).length;

	// Test Files line
	const totalFiles = result.testResults.length;
	const failedFiles =
		result.testResults.filter((fr) => fr.numFailingTests > 0).length + execErrorFiles;
	const skippedFiles = result.testResults.filter(
		(fr) => fr.numFailingTests === 0 && fr.numPassingTests === 0 && !hasExecError(fr),
	).length;
	const passedFiles = totalFiles - failedFiles - skippedFiles;

	const fileParts: Array<string> = [];
	if (passedFiles > 0) {
		fileParts.push(st.summary.passed(`${passedFiles} passed`));
	}

	if (failedFiles > 0) {
		fileParts.push(st.summary.failed(`${failedFiles} failed`));
	}

	if (skippedFiles > 0) {
		fileParts.push(st.summary.pending(`${skippedFiles} skipped`));
	}

	// Snapshots line (only shown when there are failures)
	const snapshotLine = formatSnapshotLine(result.snapshot, st);
	if (snapshotLine !== undefined) {
		lines.push(snapshotLine);
	}

	const fileTotalLabel = st.dim(`(${totalFiles})`);
	lines.push(`${st.dim(" Test Files")}  ${fileParts.join(" | ")} ${fileTotalLabel}`);

	// Tests line
	const testParts: Array<string> = [];
	if (result.numPassedTests > 0) {
		testParts.push(st.summary.passed(`${result.numPassedTests} passed`));
	}

	if (result.numFailedTests > 0) {
		testParts.push(st.summary.failed(`${result.numFailedTests} failed`));
	}

	if (result.numPendingTests > 0) {
		testParts.push(st.summary.pending(`${result.numPendingTests} skipped`));
	}

	const testTotalLabel = st.dim(`(${result.numTotalTests})`);
	lines.push(`${st.dim("      Tests")}  ${testParts.join(" | ")} ${testTotalLabel}`);

	// Type Errors line (only shown when typecheck was enabled)
	if (options?.typeErrors !== undefined) {
		const typeErrorLabel = st.dim("Type Errors");
		const typeErrorValue =
			options.typeErrors > 0
				? st.summary.failed(`${options.typeErrors} failed`)
				: st.dim("no errors");
		lines.push(`${typeErrorLabel}  ${typeErrorValue}`);
	}

	// Start at line
	const startDate = new Date(timing.startTime);
	const startAtStr = startDate.toLocaleTimeString("en-GB", { hour12: false });
	lines.push(`${st.dim("   Start at")}  ${startAtStr}`);

	// Duration line with breakdown
	const environmentMs = timing.executionMs - timing.testsMs;
	const uploadMs = timing.uploadMs ?? 0;
	const coverageMs = timing.coverageMs ?? 0;
	const cliMs = Math.max(0, timing.totalMs - uploadMs - timing.executionMs - coverageMs);
	const breakdownParts: Array<string> = [];

	if (timing.uploadMs !== undefined) {
		breakdownParts.push(
			timing.uploadCached === true
				? `upload ${timing.uploadMs}ms (cached)`
				: `upload ${timing.uploadMs}ms`,
		);
	}

	breakdownParts.push(
		`environment ${environmentMs}ms`,
		`tests ${timing.testsMs}ms`,
		`cli ${cliMs}ms`,
	);

	if (coverageMs > 0) {
		breakdownParts.push(`coverage ${coverageMs}ms`);
	}

	const breakdown = st.dim(`(${breakdownParts.join(", ")})`);
	lines.push(`${st.dim("   Duration")}  ${timing.totalMs}ms ${breakdown}`);

	return lines.join("\n");
}

export function formatResult(
	result: JestResult,
	timing: TimingResult,
	options: FormatOptions,
): string {
	const styles = createStyles(options.color);
	const lines: Array<string> = [
		// Run header
		formatRunHeader(options, styles),
	];

	// Phase 1: File summaries with test markers
	for (const file of result.testResults) {
		if (options.failuresOnly === true && file.numFailingTests === 0 && !hasExecError(file)) {
			continue;
		}

		lines.push(formatFileSummary(file, options, styles));
	}

	// Phase 2: Detailed failures
	const execErrors = result.testResults.filter(hasExecError);
	const totalDetailedFailures = result.numFailedTests + execErrors.length;

	if (totalDetailedFailures > 0) {
		lines.push("", formatFailedTestsHeader(totalDetailedFailures, styles));

		const failureCtx: FailureContext = {
			currentIndex: 1,
			totalFailures: totalDetailedFailures,
		};

		for (const file of result.testResults) {
			const failures = formatFileFailures(file, options, styles, failureCtx);
			if (failures !== "") {
				lines.push(failures);
			}
		}

		for (const file of execErrors) {
			lines.push(formatExecErrorDetail(file, styles, failureCtx, options.sourceMapper));
		}
	}

	lines.push("", formatTestSummary(result, timing, styles, { typeErrors: options.typeErrors }));

	if (!result.success) {
		const hints = formatLogHints(options, styles);
		if (hints !== "") {
			lines.push("", hints);
		}
	}

	return lines.join("\n");
}

export function formatTypecheckFailures(result: JestResult, useColor = true): string {
	const styles = createStyles(useColor);
	const lines: Array<string> = [];

	for (const file of result.testResults) {
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
	}

	return lines.join("\n");
}

export function formatTypecheckSummary(result: JestResult, useColor = true): string {
	const styles = createStyles(useColor);
	const passed = result.numPassedTests;
	const failed = result.numFailedTests;
	const total = result.numTotalTests;

	const parts: Array<string> = [];

	if (failed > 0) {
		parts.push(formatTypecheckFailures(result, useColor));
	}

	const failedLabel = styles.summary.failed(`${String(failed)} failed`);
	const failedPart = failed > 0 ? `${failedLabel}, ` : "";
	const passedPart = styles.summary.passed(`${String(passed)} passed`);
	const label = styles.dim("Type Tests:");
	parts.push(`\n${label} ${failedPart}${passedPart}, ${String(total)} total\n`);

	return parts.join("\n");
}

const PROJECT_BADGE_COLORS: Array<ColorFunc> = [
	(text: string) => color.bgYellow(color.black(text)),
	(text: string) => color.bgCyan(color.black(text)),
	(text: string) => color.bgGreen(color.black(text)),
	(text: string) => color.bgMagenta(color.black(text)),
];

const NAMED_BADGE_COLORS: Record<string, ColorFunc> = {
	blue: (text: string) => color.bgBlue(color.white(text)),
	cyan: (text: string) => color.bgCyan(color.black(text)),
	green: (text: string) => color.bgGreen(color.black(text)),
	magenta: (text: string) => color.bgMagenta(color.black(text)),
	red: (text: string) => color.bgRed(color.white(text)),
	white: (text: string) => color.bgWhite(color.black(text)),
	yellow: (text: string) => color.bgYellow(color.black(text)),
};

export interface ProjectHeaderOptions {
	displayColor?: string;
	displayName: string;
	result: JestResult;
	styles?: Styles;
	useColor?: boolean;
}

export function formatProjectBadge(
	displayName: string,
	useColor: boolean,
	displayColor?: string,
): string {
	if (!useColor) {
		return `▶ ${displayName}`;
	}

	const label = resolveBadgeColor(displayName, displayColor)(` ${displayName} `);
	return `▶ ${label}`;
}

export function formatProjectHeader(options: ProjectHeaderOptions): string {
	const { displayColor, displayName, result, styles: headerStyles, useColor = true } = options;
	const resolved = headerStyles ?? createStyles(useColor);
	const stats = computeProjectStats(result);

	const parts: Array<string> = [];
	if (stats.passedFiles > 0) {
		parts.push(resolved.summary.passed(`${stats.passedFiles} passed`));
	}

	if (stats.failedFiles > 0) {
		parts.push(resolved.summary.failed(`${stats.failedFiles} failed`));
	}

	if (stats.skippedFiles > 0) {
		parts.push(resolved.summary.pending(`${stats.skippedFiles} skipped`));
	}

	const duration = stats.durationMs > 0 ? ` - ${stats.durationMs}ms` : "";
	const meta = resolved.dim(`(${stats.totalTests} tests${duration})`);
	const fileStats = parts.join(" | ");
	const badge = formatProjectBadge(displayName, useColor, displayColor);

	return `${badge}  ${fileStats} ${meta}`;
}

export function formatProjectSection(section: ProjectSectionOptions): string {
	const {
		displayColor,
		displayName,
		failureCtx,
		options,
		result,
		styles: sectionStyles,
	} = section;
	const resolved = sectionStyles ?? createStyles(options.color);
	const lines: Array<string> = [
		formatProjectHeader({
			displayColor,
			displayName,
			result,
			styles: resolved,
			useColor: options.color,
		}),
	];

	for (const file of result.testResults) {
		if (options.failuresOnly === true && file.numFailingTests === 0 && !hasExecError(file)) {
			continue;
		}

		lines.push(formatFileSummary(file, options, resolved));
	}

	const execErrors = result.testResults.filter(hasExecError);
	const totalDetailedFailures = result.numFailedTests + execErrors.length;

	if (totalDetailedFailures > 0) {
		for (const file of result.testResults) {
			const failures = formatFileFailures(file, options, resolved, failureCtx);
			if (failures !== "") {
				lines.push(failures);
			}
		}

		for (const file of execErrors) {
			lines.push(formatExecErrorDetail(file, resolved, failureCtx, options.sourceMapper));
		}
	}

	return lines.join("\n");
}

export function formatMultiProjectResult(
	projects: Array<FormatterProjectEntry>,
	timing: TimingResult,
	options: FormatOptions,
): string {
	const styles = createStyles(options.color);

	let totalFailures = 0;
	for (const { result } of projects) {
		const execErrors = result.testResults.filter(hasExecError).length;
		totalFailures += result.numFailedTests + execErrors;
	}

	const failureCtx: FailureContext = {
		currentIndex: 1,
		totalFailures,
	};

	const sections: Array<string> = [];
	for (const { displayColor, displayName, result } of projects) {
		sections.push(
			formatProjectSection({
				displayColor,
				displayName,
				failureCtx,
				options,
				result,
				styles,
			}),
		);
	}

	const lines: Array<string> = [formatRunHeader(options, styles), sections.join("\n\n")];

	const mergedResult = mergeJestResults(projects.map((project) => project.result));

	lines.push(
		"",
		formatTestSummary(mergedResult, timing, styles, { typeErrors: options.typeErrors }),
	);

	if (!mergedResult.success) {
		const hints = formatLogHints(options, styles);
		if (hints !== "") {
			lines.push("", hints);
		}
	}

	return lines.join("\n");
}

function hashProjectName(name: string): number {
	let hash = 0;
	for (let index = 0; index < name.length; index++) {
		hash += name.charCodeAt(index) + index;
	}

	return hash % PROJECT_BADGE_COLORS.length;
}

function resolveBadgeColor(displayName: string, displayColor?: string): ColorFunc {
	if (displayColor !== undefined) {
		const named = NAMED_BADGE_COLORS[displayColor];
		if (named !== undefined) {
			return named;
		}
	}

	const hashed = PROJECT_BADGE_COLORS[hashProjectName(displayName)];
	assert(hashed !== undefined, "hash always returns valid index");
	return hashed;
}

function identity(text: string): string {
	return text;
}

function createStyles(useColor: boolean): Styles {
	if (!useColor) {
		return {
			diff: { expected: identity, received: identity },
			dim: identity,
			failBadge: identity,
			lineNumber: identity,
			location: identity,
			path: { dir: identity, file: identity },
			runBadge: identity,
			status: { fail: identity, pass: identity, pending: identity },
			summary: { failed: identity, passed: identity, pending: identity },
		};
	}

	return {
		diff: {
			expected: color.green,
			received: color.red,
		},
		dim: color.dim,
		failBadge: (text: string) => color.bgRed(color.white(color.bold(text))),
		lineNumber: color.gray,
		location: color.cyan,
		path: {
			dir: color.dim,
			file: color.bold,
		},
		runBadge: (text: string) => color.bgCyan(color.black(color.bold(text))),
		status: {
			fail: color.red,
			pass: color.green,
			pending: color.yellow,
		},
		summary: {
			failed: (text: string) => color.bold(color.red(text)),
			passed: (text: string) => color.bold(color.green(text)),
			pending: (text: string) => color.bold(color.yellow(text)),
		},
	};
}

function sumFileDuration(file: TestFileResult): number {
	let total = 0;
	for (const test of file.testResults) {
		if (test.duration !== undefined) {
			total += test.duration;
		}
	}

	return total;
}

function computeProjectStats(result: JestResult): {
	durationMs: number;
	failedFiles: number;
	passedFiles: number;
	skippedFiles: number;
	totalTests: number;
} {
	let durationMs = 0;
	let failedFiles = 0;
	let passedFiles = 0;
	let skippedFiles = 0;

	for (const file of result.testResults) {
		if (file.numFailingTests > 0 || hasExecError(file)) {
			failedFiles++;
		} else if (file.numPassingTests === 0 && file.numPendingTests > 0) {
			skippedFiles++;
		} else {
			passedFiles++;
		}

		durationMs += sumFileDuration(file);
	}

	return {
		durationMs,
		failedFiles,
		passedFiles,
		skippedFiles,
		totalTests: result.numTotalTests,
	};
}

function formatFileFailures(
	file: TestFileResult,
	options: FormatOptions,
	styles: Styles,
	failureCtx: FailureContext,
): string {
	const lines: Array<string> = [];
	const displayPath = resolveDisplayPath(file.testFilePath, options.sourceMapper);

	for (const testCase of file.testResults) {
		if (testCase.status === "failed") {
			const index = failureCtx.currentIndex;
			failureCtx.currentIndex++;

			lines.push(
				formatFailure({
					failureIndex: index,
					filePath: displayPath,
					showLuau: options.showLuau,
					sourceMapper: options.sourceMapper,
					styles,
					test: testCase,
					totalFailures: failureCtx.totalFailures,
					useColor: options.color,
				}),
			);
		}
	}

	return lines.join("\n");
}

function getTerminalWidth(): number {
	return ("columns" in process.stdout && process.stdout.columns) || 80;
}

function formatExecErrorDetail(
	file: TestFileResult,
	styles: Styles,
	failureCtx: FailureContext,
	sourceMapper?: SourceMapper,
): string {
	const lines: Array<string> = [];
	const index = failureCtx.currentIndex;
	failureCtx.currentIndex++;

	assert(file.failureMessage !== undefined, "exec error files have failureMessage");
	const displayPath = resolveDisplayPath(file.testFilePath, sourceMapper);
	const errorMessage = cleanExecErrorMessage(file.failureMessage);
	const counter = `[${index}/${failureCtx.totalFailures}]`;
	const termWidth = getTerminalWidth();
	const fillWidth = Math.max(1, termWidth - counter.length - 3);
	const separator = styles.dim(
		styles.status.fail(`${"\u23af".repeat(fillWidth)}${counter}\u23af`),
	);

	lines.push(
		`  ${styles.failBadge(" FAIL ")} ${styles.status.fail(displayPath)}`,
		`  ${styles.status.fail("Test suite failed to run")}`,
		"",
		`  ${styles.status.fail(errorMessage)}`,
	);

	const hint = getExecErrorHint(errorMessage);
	if (hint !== undefined) {
		lines.push("", `  ${styles.dim("Hint:")} ${hint}`);
	}

	lines.push("", `  ${separator}`);

	return lines.join("\n");
}

function formatTestInGroup(testCase: TestCaseResult, styles: Styles): string {
	const duration =
		testCase.duration !== undefined ? styles.lineNumber(` ${testCase.duration}ms`) : "";
	if (testCase.status === "passed") {
		const marker = styles.status.pass("     ✓");
		// Red title is intentional: this function only runs inside failed suites.
		// The green ✓ already shows the individual test passed — the red reflects
		// the parent suite's failure.
		const title = styles.status.fail(` ${testCase.title}`);
		return `${marker}${title}${duration}`;
	}

	const failedText = `     × ${testCase.title}`;

	return `${styles.status.fail(failedText)}${duration}`;
}

function formatDescribeGroup(
	describeName: string,
	tests: Array<TestCaseResult>,
	styles: Styles,
): Array<string> {
	const lines: Array<string> = [];
	const groupHasFailure = tests.some((testCase) => testCase.status === "failed");
	const groupTestCount = tests.length;
	const groupDuration = tests.reduce((sum, testCase) => sum + (testCase.duration ?? 0), 0);
	const groupDurationStr = styles.lineNumber(` ${groupDuration}ms`);

	if (groupHasFailure) {
		const failedCount = tests.filter((testCase) => testCase.status === "failed").length;
		const groupMeta =
			styles.dim(`(${groupTestCount} tests | `) +
			styles.summary.failed(`${failedCount} failed`) +
			styles.dim(")");
		const header = styles.status.fail(`   ❯ ${describeName}`);
		lines.push(`${header} ${groupMeta}${groupDurationStr}`);

		for (const testCase of tests) {
			lines.push(formatTestInGroup(testCase, styles));
		}
	} else {
		const groupMeta = styles.dim(`(${groupTestCount} tests)`);
		const marker = styles.status.pass("   ✓");
		const name = styles.status.fail(` ${describeName}`);
		lines.push(`${marker}${name} ${groupMeta}${groupDurationStr}`);
	}

	return lines;
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

function formatFailedFileSummary(
	file: TestFileResult,
	testCount: number,
	styles: Styles,
	displayPath: string,
): Array<string> {
	const lines: Array<string> = [];
	const failedMeta = styles.summary.failed(`${file.numFailingTests} failed`);
	const metaPrefix = styles.dim(`(${testCount} tests | `);
	const metaSuffix = styles.dim(")");
	const meta = `${metaPrefix}${failedMeta}${metaSuffix}`;
	const header = styles.status.fail(` ❯ ${displayPath}`);

	lines.push(`${header} ${meta}`);

	const groups = groupByDescribe(file.testResults);
	for (const [describeName, tests] of groups) {
		lines.push(...formatDescribeGroup(describeName, tests, styles));
	}

	return lines;
}

function formatFilePath(filePath: string, styles: Styles): string {
	const directory = path.dirname(filePath);
	const base = path.basename(filePath);
	const directoryWithSlash = styles.path.dir(`${directory}/`);
	const fileName = styles.path.file(base);
	return directory && directory !== "." ? directoryWithSlash + fileName : fileName;
}

function formatExecErrorFileSummary(
	file: TestFileResult,
	formattedPath: string,
	styles: Styles,
): Array<string> {
	const symbol = styles.status.fail("✗");
	assert(file.failureMessage !== undefined, "exec error files have failureMessage");
	const errorMessage = cleanExecErrorMessage(file.failureMessage);
	return [` ${symbol} ${formattedPath}`, `   ${styles.status.fail(errorMessage)}`];
}

function formatPass(test: TestCaseResult, styles: Styles): string {
	const duration = test.duration !== undefined ? styles.dim(` ${test.duration}ms`) : "";
	return styles.status.pass(`  ✓ ${test.fullName}`) + duration;
}

function formatPassedFileSummary(
	file: TestFileResult,
	ctx: { formattedPath: string; styles: Styles; testCount: number; verbose: boolean },
): Array<string> {
	const lines: Array<string> = [];
	const fileMs = sumFileDuration(file);
	const symbol = ctx.styles.status.pass("✓");
	const duration = fileMs > 0 ? ` - ${fileMs}ms` : "";
	const meta = ctx.styles.dim(`(${ctx.testCount} tests${duration})`);
	lines.push(` ${symbol} ${ctx.formattedPath} ${meta}`);

	if (ctx.verbose) {
		for (const testCase of file.testResults) {
			if (testCase.status === "passed") {
				lines.push(formatPass(testCase, ctx.styles));
			}
		}
	}

	return lines;
}

function formatFileSummary(file: TestFileResult, options: FormatOptions, styles: Styles): string {
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

function formatLogHints(options: FormatOptions, styles: Styles): string {
	const lines: Array<string> = [];

	if (options.outputFile !== undefined) {
		lines.push(styles.dim(`  View ${options.outputFile} for full Jest output`));
	}

	if (options.gameOutput !== undefined) {
		lines.push(styles.dim(`  View ${options.gameOutput} for Roblox game logs`));
	}

	return lines.join("\n");
}

function mergeJestResults(results: Array<JestResult>): JestResult {
	let numberFailedTests = 0;
	let numberPassedTests = 0;
	let numberPendingTests = 0;
	let numberTodoTests = 0;
	let numberTotalTests = 0;
	let startTime = Number.POSITIVE_INFINITY;
	let success = true;
	let snapshotAdded = 0;
	let snapshotMatched = 0;
	let snapshotTotal = 0;
	let snapshotUnmatched = 0;
	let snapshotUpdated = 0;
	let hasSnapshot = false;
	const testResults: JestResult["testResults"] = [];

	for (const result of results) {
		numberFailedTests += result.numFailedTests;
		numberPassedTests += result.numPassedTests;
		numberPendingTests += result.numPendingTests;
		numberTodoTests += result.numTodoTests ?? 0;
		numberTotalTests += result.numTotalTests;
		startTime = Math.min(startTime, result.startTime);
		success &&= result.success;
		testResults.push(...result.testResults);

		if (result.snapshot !== undefined) {
			hasSnapshot = true;
			snapshotAdded += result.snapshot.added;
			snapshotMatched += result.snapshot.matched;
			snapshotTotal += result.snapshot.total;
			snapshotUnmatched += result.snapshot.unmatched;
			snapshotUpdated += result.snapshot.updated;
		}
	}

	return {
		numFailedTests: numberFailedTests,
		numPassedTests: numberPassedTests,
		numPendingTests: numberPendingTests,
		numTodoTests: numberTodoTests > 0 ? numberTodoTests : undefined,
		numTotalTests: numberTotalTests,
		snapshot: hasSnapshot
			? {
					added: snapshotAdded,
					matched: snapshotMatched,
					total: snapshotTotal,
					unmatched: snapshotUnmatched,
					updated: snapshotUpdated,
				}
			: undefined,
		startTime,
		success,
		testResults,
	};
}

function expandTabs(text: string, tabWidth = 4): string {
	let result = "";
	for (const char of text) {
		if (char === "\t") {
			const spaces = tabWidth - (result.length % tabWidth);
			result += " ".repeat(spaces);
		} else {
			result += char;
		}
	}

	return result;
}

function highlightSyntax(filePath: string, code: string, useColor: boolean): string {
	if (!useColor) {
		return code;
	}

	return highlightCode(filePath, code);
}

function formatDiffBlock(parsed: ParsedError, styles: Styles): Array<string> {
	if (parsed.snapshotDiff !== undefined) {
		const lines: Array<string> = [""];
		for (const diffLine of parsed.snapshotDiff.split("\n")) {
			if (diffLine.startsWith("- ")) {
				lines.push(styles.diff.expected(diffLine));
			} else if (diffLine.startsWith("+ ")) {
				lines.push(styles.diff.received(diffLine));
			} else {
				lines.push(styles.dim(diffLine));
			}
		}

		return lines;
	}

	if (parsed.expected !== undefined && parsed.received !== undefined) {
		return [
			"",
			styles.diff.expected("- Expected"),
			styles.diff.received("+ Received"),
			"",
			styles.diff.expected(`- ${parsed.expected}`),
			styles.diff.received(`+ ${parsed.received}`),
		];
	}

	return [];
}

function formatErrorLine(parsed: ParsedError, styles: Styles, useColor: boolean): string {
	if (useColor && parsed.message.startsWith("Error:")) {
		return styles.status.fail(color.bold("Error:") + parsed.message.slice(6));
	}

	return styles.status.fail(parsed.message);
}

function formatFallbackSnippet(message: string, styles: Styles, useColor: boolean): Array<string> {
	const location = parseSourceLocation(message);
	if (location === undefined) {
		return [];
	}

	const snippet = getSourceSnippet({
		column: location.column,
		context: 2,
		filePath: location.path,
		line: location.line,
	});
	if (snippet === undefined) {
		return [];
	}

	return ["", formatSourceSnippet(snippet, location.path, { styles, useColor })];
}

function formatMappedLocationSnippets(
	loc: MappedLocation,
	showLuau: boolean,
	styles: Styles,
	useColor: boolean,
): Array<string> {
	const snippets: Array<string> = [];

	// When TS fields are present, show TypeScript snippet (+ optional Luau)
	if (loc.tsPath !== undefined && loc.tsLine !== undefined) {
		const tsSnippet = getSourceSnippet({
			column: loc.tsColumn,
			context: 2,
			filePath: loc.tsPath,
			line: loc.tsLine,
			sourceContent: loc.sourceContent,
		});
		if (tsSnippet !== undefined) {
			const label = showLuau ? "TypeScript" : undefined;
			snippets.push(
				"",
				formatSourceSnippet(tsSnippet, loc.tsPath, {
					language: label,
					styles,
					useColor,
				}),
			);
		}

		if (showLuau) {
			const luauSnippet = getSourceSnippet({
				context: 2,
				filePath: loc.luauPath,
				line: loc.luauLine,
			});
			if (luauSnippet !== undefined) {
				snippets.push(
					"",
					formatSourceSnippet(luauSnippet, loc.luauPath, {
						language: "Luau",
						styles,
						useColor,
					}),
				);
			}
		}
	} else {
		// Luau-only: show Luau snippet without language label
		const luauSnippet = getSourceSnippet({
			context: 2,
			filePath: loc.luauPath,
			line: loc.luauLine,
		});
		if (luauSnippet !== undefined) {
			snippets.push("", formatSourceSnippet(luauSnippet, loc.luauPath, { styles, useColor }));
		}
	}

	return snippets;
}

function formatSnapshotCallSnippet(
	filePath: string,
	styles: Styles,
	useColor: boolean,
): Array<string> {
	if (!fs.existsSync(filePath)) {
		return [];
	}

	const content = fs.readFileSync(filePath, "utf-8");
	const fileLines = content.split("\n");
	const snapshotIndices = fileLines.reduce<Array<number>>((accumulator, fileLine, index) => {
		if (fileLine.includes("toMatchSnapshot")) {
			accumulator.push(index);
		}

		return accumulator;
	}, []);
	if (snapshotIndices.length !== 1) {
		return [];
	}

	// eslint-disable-next-line ts/no-non-null-assertion -- length checked above
	const line = snapshotIndices[0]! + 1;
	const snippet = getSourceSnippet({ context: 2, filePath, line, sourceContent: content });
	if (snippet === undefined) {
		return [];
	}

	return ["", formatSourceSnippet(snippet, filePath, { styles, useColor })];
}

function resolveSourceSnippets(options: {
	filePath?: string;
	hasSnapshotDiff: boolean;
	mappedLocations: Array<MappedLocation>;
	message: string;
	showLuau: boolean;
	sourceMapper?: SourceMapper;
	styles: Styles;
	useColor: boolean;
}): Array<string> {
	const {
		filePath,
		hasSnapshotDiff,
		mappedLocations,
		message,
		showLuau,
		sourceMapper,
		styles,
		useColor,
	} = options;

	if (mappedLocations.length > 0) {
		return mappedLocations.flatMap((loc) => {
			return formatMappedLocationSnippets(loc, showLuau, styles, useColor);
		});
	}

	const fallback = formatFallbackSnippet(message, styles, useColor);
	if (fallback.length > 0) {
		return fallback;
	}

	if (hasSnapshotDiff && filePath !== undefined) {
		const resolvedPath = resolveDisplayPath(filePath, sourceMapper);
		return formatSnapshotCallSnippet(resolvedPath, styles, useColor);
	}

	return [];
}

function formatFailureMessage(
	originalMessage: string,
	options: {
		filePath?: string;
		showLuau: boolean;
		sourceMapper?: SourceMapper;
		styles: Styles;
		useColor: boolean;
	},
): Array<string> {
	const { filePath, showLuau, sourceMapper, styles, useColor } = options;

	let mappedLocations: Array<MappedLocation> = [];
	let message = originalMessage;

	if (sourceMapper !== undefined) {
		({ locations: mappedLocations, message } =
			sourceMapper.mapFailureWithLocations(originalMessage));
	}

	const parsed = parseErrorMessage(originalMessage);

	return [
		formatErrorLine(parsed, styles, useColor),
		...formatDiffBlock(parsed, styles),
		...resolveSourceSnippets({
			filePath,
			hasSnapshotDiff: parsed.snapshotDiff !== undefined,
			mappedLocations,
			message,
			showLuau,
			sourceMapper,
			styles,
			useColor,
		}),
	];
}

function formatSnapshotLine(
	snapshot: SnapshotSummary | undefined,
	styles: Styles,
): string | undefined {
	if (snapshot === undefined || snapshot.unmatched === 0) {
		return undefined;
	}

	const label = styles.dim("  Snapshots");
	const failed = styles.summary.failed(`${snapshot.unmatched} failed`);

	return `${label}  ${failed}`;
}
