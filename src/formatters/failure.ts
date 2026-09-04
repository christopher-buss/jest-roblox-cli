import assert from "node:assert";
import color from "tinyrainbow";

import type { MappedLocation, SourceMapper } from "../source-mapper/index.ts";
import { execErrorTitle, type TestCaseResult, type TestFileResult } from "../types/jest-result.ts";
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

interface ParsedError {
	expected?: string | undefined;
	message: string;
	received?: string | undefined;
	snapshotDiff?: string | undefined;
}

export function getExecErrorHint(message: string): string | undefined {
	for (const [pattern, hint] of EXEC_ERROR_HINTS) {
		if (pattern.test(message)) {
			return hint;
		}
	}

	return undefined;
}

export function parseErrorMessage(message: string): ParsedError {
	const lines = message.split("\n");
	const firstLine = lines[0];
	assert(firstLine !== undefined, "split always returns ≥1 element");

	const snapshotHeaderIndex = lines.findIndex((line) => SNAPSHOT_HEADER.test(line));
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
 */
export function cleanExecErrorMessage(raw: string): string {
	if (raw === "") {
		return "";
	}

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
	failureIndex?: number | undefined;
	filePath?: string | undefined;
	showLuau?: boolean | undefined;
	sourceMapper?: SourceMapper | undefined;
	styles?: Styles | undefined;
	test: TestCaseResult;
	totalFailures?: number | undefined;
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

/** Renders every failed test case in one file, advancing the shared counter. */
export function formatFileFailures(
	file: TestFileResult,
	options: FormatOptions,
	styles: Styles,
	failureCtx: FailureContext,
): string {
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
 */
export function formatExecErrorDetail(
	file: TestFileResult,
	styles: Styles,
	failureCtx: FailureContext,
	sourceMapper?: SourceMapper,
): string {
	const index = failureCtx.currentIndex;
	failureCtx.currentIndex++;

	assert(file.failureMessage !== undefined, "exec error files have failureMessage");
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

// The `⎯` rule fills the terminal up to the `[n/total]` counter it ends with.
function formatFailureSeparator(failureIndex: number, totalFailures: number): string {
	const counter = `[${failureIndex}/${totalFailures}]`;
	const fillWidth = Math.max(1, getTerminalWidth() - counter.length - 3);
	return `${"⎯".repeat(fillWidth)}${counter}⎯`;
}

function formatErrorLine(parsed: ParsedError, styles: Styles, useColor: boolean): string {
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
		showLuau,
		sourceMapper,
		styles,
		useColor,
	}: {
		filePath?: string | undefined;
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

// Two spaces on every content line; a blank one is left alone so the block
// carries neither trailing whitespace nor colour codes wrapping nothing.
function indentMessage(message: string, styles: Styles): Array<string> {
	return message.split("\n").map((line) => (line === "" ? "" : `  ${styles.status.fail(line)}`));
}
