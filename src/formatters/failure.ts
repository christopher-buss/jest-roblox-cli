import assert from "node:assert";
import color from "tinyrainbow";

import type { MappedLocation, SourceMapper } from "../source-mapper/index.ts";
import { execErrorTitle } from "../types/exec-error-file.ts";
import type { TestCaseResult, TestFileResult } from "../types/jest-result-types.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import {
	type FailureContext,
	type FormatOptions,
	getTerminalWidth,
	resolveDisplayPath,
} from "./shared.ts";
import { resolveSourceSnippets } from "./snippets.ts";
import { createStyles, type Styles } from "./styles.ts";

const SNAPSHOT_HEADER = /^- Snapshot\s+- \d+/;
const EXPECTED_VALUE = /Expected\b.*?:\s*(.+)/;
const RECEIVED_VALUE = /Received\b.*?:\s*(.+)/;
const ROBLOX_PATH_CHAIN = /^(?:[A-Za-z][\w.@-]*:\d+:\s*)+/;

const EXEC_ERROR_HINTS: Array<[pattern: RegExp, hint: string]> = [
	[
		/loadstring\(\) is not available/,
		'loadstring() must be enabled for Jest to run. Add to your project.json:\n\n  "ServerScriptService": {\n    "$properties": {\n      "LoadStringEnabled": true\n    }\n  }',
	],
];

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
	 * Maps the test file to the path it is shown by.
	 */
	sourceMapper?: SourceMapper | undefined;
	/**
	 * Palette to render with.
	 */
	styles: Styles;
}

interface ParsedError {
	expected?: string | undefined;
	message: string;
	received?: string | undefined;
	snapshotDiff?: string | undefined;
}

/**
 * Find a setup hint for a known suite-level error.
 * @param message - Cleaned exec error message.
 * @returns The hint, or undefined when no known pattern matches.
 */
export function getExecErrorHint(message: string): string | undefined {
	for (const [pattern, hint] of EXEC_ERROR_HINTS) {
		if (pattern.test(message)) {
			return hint;
		}
	}

	return undefined;
}

/**
 * Split a failure message into its first line and any snapshot diff or expected/received pair.
 * @param message - Raw failure message.
 * @returns The parsed parts; diff fields are absent when not found.
 */
export function parseErrorMessage(message: string): ParsedError {
	const lines = message.split("\n");
	const firstLine = lines[0];
	assert(firstLine !== undefined);

	const snapshotHeaderIndex = lines.findIndex((line) => SNAPSHOT_HEADER.test(line));
	if (snapshotHeaderIndex !== -1) {
		const diffLines: Array<string> = [];
		for (let index = snapshotHeaderIndex; index < lines.length; index++) {
			// oxlint-disable-next-line typescript/no-non-null-assertion -- Loop condition
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

	const expectedMatch = message.match(EXPECTED_VALUE);
	const receivedMatch = message.match(RECEIVED_VALUE);
	return {
		expected: expectedMatch?.[1],
		message: firstLine,
		received: receivedMatch?.[1],
	};
}

/**
 * Extracts the meaningful error message from a Jest `failureMessage` string.
 * Strips the "● Test suite failed to run" header, Roblox DataModel path
 * chains, and stack trace lines.
 * @param raw - Jest `failureMessage` of a file whose suite threw.
 * @returns The first content line without path prefixes, or the trimmed input when no line follows the header.
 */
export function cleanExecErrorMessage(raw: string): string {
	const lines = raw.split("\n");

	// Find the first content line after the "● Test suite failed to run" header
	let contentLine: string | undefined;
	let isPastHeader = false;
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("●")) {
			isPastHeader = true;
			continue;
		}

		if (isPastHeader && trimmed !== "") {
			contentLine = trimmed;
			break;
		}
	}

	if (contentLine === undefined) {
		return raw.trim();
	}

	// Strip chained Roblox path prefixes: "Path:123: Path:456: actual message"
	return contentLine.replace(ROBLOX_PATH_CHAIN, "");
}

/**
 * Render one failed test: the FAIL header, each message with its diff and snippets, and an optional numbered separator.
 * @param options - Failed test, its display path, palette and numbering.
 * @returns The indented failure block.
 */
export function formatFailure({
	failureIndex,
	filePath,
	fileSystem = nodeFileSystem,
	showLuau = false,
	sourceMapper,
	styles,
	test,
	totalFailures,
	useColor = true,
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
	 * Show the Luau source beside mapped TypeScript snippets.
	 */
	showLuau?: boolean | undefined;
	/**
	 * Maps Luau locations in the messages back to TypeScript source.
	 */
	sourceMapper?: SourceMapper | undefined;
	/**
	 * Palette to render with; built from `useColor` when absent.
	 */
	styles?: Styles | undefined;
	/**
	 * Failed test to render.
	 */
	test: TestCaseResult;
	/**
	 * Failure total shown in the separator; needs `failureIndex`.
	 */
	totalFailures?: number | undefined;
	/**
	 * Emit ANSI color; defaults to true.
	 */
	useColor?: boolean | undefined;
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
				fileSystem,
				showLuau,
				sourceMapper,
				styles: st,
				useColor,
			}),
		);
	}

	// Add footer separator with index
	if (failureIndex !== undefined && totalFailures !== undefined) {
		lines.push("", st.dim(st.status.fail(formatFailureSeparator(failureIndex, totalFailures))));
	}

	// Indent all lines
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
	const displayPath = resolveDisplayPath(file.testFilePath, options.sourceMapper);

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
				showLuau: options.showLuau,
				sourceMapper: options.sourceMapper,
				styles,
				test: testCase,
				totalFailures: failureCtx.totalFailures,
				useColor: options.color,
			}),
		);
	}

	return lines.join("\n");
}

/**
 * Renders a file that never got as far as running tests — the suite itself
 * threw — as one failure block in the shared numbering.
 * @param options - File, source mapper, palette and shared numbering.
 * @returns The failure block.
 */
export function formatExecErrorDetail({
	failureCtx,
	file,
	sourceMapper,
	styles,
}: FormatExecErrorDetailOptions): string {
	const index = failureCtx.currentIndex;
	failureCtx.currentIndex++;

	assert(file.failureMessage !== undefined);
	const displayPath = resolveDisplayPath(file.testFilePath, sourceMapper);
	const errorMessage = cleanExecErrorMessage(file.failureMessage);
	const separator = styles.dim(
		styles.status.fail(formatFailureSeparator(index, failureCtx.totalFailures)),
	);

	const badge =
		file.timedOut === true ? styles.timeoutBadge(" TIMEOUT ") : styles.failBadge(" FAIL ");

	// Indented line by line rather than as one block: the message can be a
	// multi-line report, and indenting only its first line would leave the rest
	// hanging off the left margin the whole failure block is drawn against.
	const lines: Array<string> = [
		`  ${badge} ${styles.status.fail(displayPath)}`,
		`  ${styles.status.fail(execErrorTitle(file))}`,
		"",
		...indentMessage(errorMessage, styles),
	];

	const hint = getExecErrorHint(errorMessage);
	if (hint !== undefined) {
		lines.push("", `  ${styles.dim("Hint:")} ${hint}`);
	}

	lines.push("", `  ${separator}`);

	return lines.join("\n");
}

/**
 * The `⎯` rule fills the terminal up to the `[n/total]` counter it ends with.
 * @param failureIndex - Number of this failure.
 * @param totalFailures - Failures in the run.
 * @returns The separator line.
 */
function formatFailureSeparator(failureIndex: number, totalFailures: number): string {
	const counter = `[${failureIndex}/${totalFailures}]`;
	const fillWidth = Math.max(1, getTerminalWidth() - counter.length - 3);
	return `${"⎯".repeat(fillWidth)}${counter}⎯`;
}

function formatErrorLine({
	parsed,
	styles,
	useColor,
}: {
	parsed: ParsedError;
	styles: Styles;
	useColor: boolean;
}): string {
	if (useColor && parsed.message.startsWith("Error:")) {
		return styles.status.fail(color.bold("Error:") + parsed.message.slice(6));
	}

	return styles.status.fail(parsed.message);
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

function formatFailureMessage(
	originalMessage: string,
	{
		filePath,
		fileSystem,
		showLuau,
		sourceMapper,
		styles,
		useColor,
	}: {
		filePath?: string | undefined;
		fileSystem: FileSystem;
		showLuau: boolean;
		sourceMapper?: SourceMapper | undefined;
		styles: Styles;
		useColor: boolean;
	},
): Array<string> {
	let mappedLocations: Array<MappedLocation> = [];
	let message = originalMessage;

	if (sourceMapper !== undefined) {
		({ locations: mappedLocations, message } =
			sourceMapper.mapFailureWithLocations(originalMessage));
	}

	const parsed = parseErrorMessage(originalMessage);

	return [
		formatErrorLine({ parsed, styles, useColor }),
		...formatDiffBlock(parsed, styles),
		...resolveSourceSnippets({
			filePath,
			fileSystem,
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

/**
 * Two spaces on every content line; a blank one is left alone so the block
 * carries neither trailing whitespace nor colour codes wrapping nothing.
 * @param message - Message to indent.
 * @param styles - Palette to paint lines with.
 * @returns The indented lines.
 */
function indentMessage(message: string, styles: Styles): Array<string> {
	return message.split("\n").map((line) => (line === "" ? "" : `  ${styles.status.fail(line)}`));
}
