import assert from "node:assert";

import type { SourceMapper } from "../source-mapper/index.ts";
import type { Styles } from "../terminal/palette.ts";
import { getTerminalWidth } from "../terminal/width.ts";
import type { TestCaseResult, TestFileResult } from "../types/jest-result-types.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import type { ParsedError } from "./failure-message.ts";
import {
	describeExecError,
	type FailureDetail,
	failureDetail,
	locateFailure,
	snippetSources,
} from "./failure-model.ts";
import { type FailureContext, type FormatOptions, resolveDisplayPath } from "./shared.ts";
import { resolveSourceSnippets } from "./snippets.ts";

/**
 * Inputs of `formatFileFailures`.
 */
export interface FormatFileFailuresOptions {
	/**
	 * Shared failure numbering, advanced once per rendered failure.
	 */
	failureCtx: FailureContext;
	/**
	 * File whose failed tests to render.
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

/**
 * Inputs of `formatExecErrorDetail`.
 */
export interface FormatExecErrorDetailOptions {
	/**
	 * Shared failure numbering, advanced by one.
	 */
	failureCtx: FailureContext;
	/**
	 * File whose suite threw; `failureMessage` must be set.
	 */
	file: TestFileResult;
	/**
	 * Root the test file is shown relative to.
	 */
	rootDir: string;
	/**
	 * Maps the test file to the path it is shown by.
	 */
	sourceMapper?: SourceMapper | undefined;
	/**
	 * Palette to render with.
	 */
	styles: Styles;
}

/**
 * Render one failed test as an indented FAIL block.
 * @param options - Failed test, its display path, palette and numbering.
 * @returns The indented failure block.
 */
export function formatFailure({
	failureIndex,
	filePath,
	fileSystem = nodeFileSystem,
	rootDir,
	showLuau = false,
	sourceMapper,
	sourcePath,
	styles: st,
	test,
	totalFailures,
}: {
	/**
	 * Number shown in the separator; needs `totalFailures`.
	 */
	failureIndex?: number | undefined;
	/**
	 * Display path that leads the header.
	 */
	filePath?: string | undefined;
	/**
	 * File system that snippets are read through.
	 */
	fileSystem?: FileSystem;
	/**
	 * Root snippet paths are shown relative to; full paths when absent.
	 */
	rootDir?: string | undefined;
	/**
	 * Show the Luau source beside mapped TypeScript snippets.
	 */
	showLuau?: boolean | undefined;
	/**
	 * Maps Luau locations in the messages back to TypeScript source.
	 */
	sourceMapper?: SourceMapper | undefined;
	/**
	 * Path snippets read the test file from.
	 */
	sourcePath?: string | undefined;
	/**
	 * Palette to render with.
	 */
	styles: Styles;
	/**
	 * Failed test to render.
	 */
	test: TestCaseResult;
	/**
	 * Failure total shown in the separator; needs `failureIndex`.
	 */
	totalFailures?: number | undefined;
}): string {
	const lines: Array<string> = [];

	const pathParts = filePath !== undefined ? [filePath] : [];
	pathParts.push(...test.ancestorTitles, test.title);
	const testPath = pathParts.join(" > ");

	lines.push("", `${st.failBadge(" FAIL ")} ${st.status.fail(testPath)}`);

	for (const originalMessage of test.failureMessages) {
		lines.push(
			...formatFailureMessage(originalMessage, {
				filePath: sourcePath,
				fileSystem,
				rootDir,
				showLuau,
				sourceMapper,
				styles: st,
			}),
		);
	}

	if (failureIndex !== undefined && totalFailures !== undefined) {
		lines.push("", st.dim(st.status.fail(formatFailureSeparator(failureIndex, totalFailures))));
	}

	return lines.map((line) => `  ${line}`).join("\n");
}

/**
 * Renders every failed test case in one file, advancing the shared counter.
 * @param options - File, format options, palette and shared numbering.
 * @returns The failure blocks joined by newlines.
 */
export function formatFileFailures({
	failureCtx,
	file,
	options,
	styles,
}: FormatFileFailuresOptions): string {
	const lines: Array<string> = [];
	const displayPath = resolveDisplayPath(file.testFilePath, options);

	for (const testCase of file.testResults) {
		if (testCase.status !== "failed") {
			continue;
		}

		const index = failureCtx.currentIndex;
		failureCtx.currentIndex++;

		lines.push(
			formatFailure({
				failureIndex: index,
				filePath: displayPath,
				rootDir: options.rootDir,
				showLuau: options.showLuau,
				sourceMapper: options.sourceMapper,
				sourcePath: file.testFilePath,
				styles,
				test: testCase,
				totalFailures: failureCtx.totalFailures,
			}),
		);
	}

	return lines.join("\n");
}

/**
 * Render a file whose suite threw as one numbered failure block.
 * @param options - File, source mapper, palette and shared numbering.
 * @returns The failure block.
 */
export function formatExecErrorDetail({
	failureCtx,
	file,
	rootDir,
	sourceMapper,
	styles,
}: FormatExecErrorDetailOptions): string {
	const index = failureCtx.currentIndex;
	failureCtx.currentIndex++;

	const { failureMessage } = file;
	assert(failureMessage !== undefined);
	const displayPath = resolveDisplayPath(file.testFilePath, { rootDir, sourceMapper });
	const block = describeExecError({ ...file, failureMessage });
	const separator = styles.dim(
		styles.status.fail(formatFailureSeparator(index, failureCtx.totalFailures)),
	);

	const badge =
		block.badge === "TIMEOUT" ? styles.timeoutBadge(" TIMEOUT ") : styles.failBadge(" FAIL ");

	const lines: Array<string> = [
		`  ${badge} ${styles.status.fail(displayPath)}`,
		`  ${styles.status.fail(block.title)}`,
		"",
		...indentMessage(block.message, styles),
	];

	if (block.hint !== undefined) {
		lines.push("", `  ${styles.dim("Hint:")} ${block.hint}`);
	}

	lines.push("", `  ${separator}`);

	return lines.join("\n");
}

function formatFailureSeparator(failureIndex: number, totalFailures: number): string {
	const counter = `[${failureIndex}/${totalFailures}]`;
	const fillWidth = Math.max(1, getTerminalWidth() - counter.length - 3);
	return `${"⎯".repeat(fillWidth)}${counter}⎯`;
}

function formatErrorLine(parsed: ParsedError, styles: Styles): string {
	if (parsed.message.startsWith("Error:")) {
		return styles.status.fail(styles.bold("Error:") + parsed.message.slice(6));
	}

	return styles.status.fail(parsed.message);
}

function formatDiffBlock(detail: FailureDetail, styles: Styles): Array<string> {
	if (detail.kind === "snapshot") {
		const lines: Array<string> = [""];
		for (const diffLine of detail.diff.split("\n")) {
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

	if (detail.kind === "values") {
		return [
			"",
			styles.diff.expected("- Expected"),
			styles.diff.received("+ Received"),
			"",
			styles.diff.expected(`- ${detail.expected}`),
			styles.diff.received(`+ ${detail.received}`),
		];
	}

	return [];
}

function formatFailureMessage(
	originalMessage: string,
	{
		filePath,
		fileSystem,
		rootDir,
		showLuau,
		sourceMapper,
		styles,
	}: {
		filePath?: string | undefined;
		fileSystem: FileSystem;
		rootDir?: string | undefined;
		showLuau: boolean;
		sourceMapper?: SourceMapper | undefined;
		styles: Styles;
	},
): Array<string> {
	const located = locateFailure(originalMessage, sourceMapper);

	return [
		formatErrorLine(located.parsed, styles),
		...formatDiffBlock(failureDetail(located.parsed), styles),
		...resolveSourceSnippets({
			filePath,
			fileSystem,
			hasSnapshotDiff: located.parsed.snapshotDiff !== undefined,
			rootDir,
			showLuau,
			sourceMapper,
			sources: snippetSources(located),
			styles,
		}),
	];
}

function indentMessage(message: string, styles: Styles): Array<string> {
	return message.split("\n").map((line) => (line === "" ? "" : `  ${styles.status.fail(line)}`));
}
