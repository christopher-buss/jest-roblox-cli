import assert from "node:assert";
import * as fs from "node:fs";

import {
	getSourceSnippet,
	type MappedLocation,
	type SourceMapper,
	type SourceSnippet,
} from "../source-mapper/index.ts";
import { highlightCode } from "../utils/colors.ts";
import { createStyles, type Styles } from "./styles.ts";

// The path segment is length-bounded so an unanchored `.match` over a long
// message stays linear (an unbounded run of non-colon chars backtracks per
// start position); 512 clears any real source path.
const SOURCE_LOCATION = /([^\s:]{1,512}\.(?:tsx?|luau?)):(\d+)(?::(\d+))?/;

const SNIPPET_INDENT = "\t";

interface SourceLocation {
	column?: number | undefined;
	line: number;
	path: string;
}

interface TsSnippetOptions {
	loc: MappedLocation;
	showLuau: boolean;
	styles: Styles;
	/** Narrowed by the caller; see `tsSnippetLines`. */
	tsLine: number;
	/** Narrowed by the caller; see `tsSnippetLines`. */
	tsPath: string;
	useColor: boolean;
}

export function formatSourceSnippet(
	snippet: SourceSnippet,
	filePath: string,
	options?: {
		language?: string | undefined;
		styles?: Styles | undefined;
		useColor?: boolean | undefined;
	},
): string {
	const isColorEnabled = options?.useColor ?? true;
	const styles = options?.styles ?? createStyles(isColorEnabled);
	const lines = [formatLocationHeader(snippet, filePath, options?.language, styles)];

	// Determine padding for line numbers
	const maxLineNumber = Math.max(...snippet.lines.map((line) => line.num));
	const padding = String(maxLineNumber).length;

	for (const line of snippet.lines) {
		const prefix = `${String(line.num).padStart(padding)}|`;
		const expandedContent = expandTabs(line.content);
		const highlighted = highlightSyntax(filePath, expandedContent, isColorEnabled);
		lines.push(`${SNIPPET_INDENT}${styles.lineNumber(prefix)} ${highlighted}`);

		if (line.num === snippet.failureLine && snippet.column !== undefined) {
			lines.push(formatCaretLine(line.content, snippet.column, padding, styles));
		}
	}

	return lines.join("\n");
}

export function parseSourceLocation(message: string): SourceLocation | undefined {
	// Match patterns like "path/to/file.ts:25" or "path/to/file.ts:25:12"
	const match = message.match(SOURCE_LOCATION);
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

/**
 * Picks the snippets that best explain a failure: the mapped locations when the
 * source mapper resolved any, else a location parsed out of the raw message,
 * else the lone `toMatchSnapshot` call in the test file.
 */
export function resolveSourceSnippets({
	filePath,
	hasSnapshotDiff,
	mappedLocations,
	message,
	showLuau,
	sourceMapper,
	styles,
	useColor,
}: {
	filePath?: string | undefined;
	hasSnapshotDiff: boolean;
	mappedLocations: Array<MappedLocation>;
	message: string;
	showLuau: boolean;
	sourceMapper?: SourceMapper | undefined;
	styles: Styles;
	useColor: boolean;
}): Array<string> {
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
		// File I/O: need a real on-disk path. `resolveDisplayPath` may rewrite
		// `init.spec.luau` → `index.spec.luau` for roblox-ts, but the on-disk
		// file is still `init.*`, so reading would fail and the snippet would
		// silently disappear.
		const resolvedPath = sourceMapper?.resolveTestFilePath(filePath) ?? filePath;
		return formatSnapshotCallSnippet(resolvedPath, styles, useColor);
	}

	return [];
}

// Location header: ❯ path:line:col  (Language)
function formatLocationHeader(
	snippet: SourceSnippet,
	filePath: string,
	language: string | undefined,
	styles: Styles,
): string {
	const location =
		snippet.column !== undefined
			? `${filePath}:${snippet.failureLine}:${snippet.column}`
			: `${filePath}:${snippet.failureLine}`;
	const langSuffix = language !== undefined ? styles.dim(`  (${language})`) : "";
	return styles.location(` ❯ ${location}`) + langSuffix;
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

// Tabs before the column widen the caret's offset, so the prefix is expanded
// the same way the rendered line was.
function formatCaretLine(content: string, column: number, padding: number, styles: Styles): string {
	const beforeColumn = expandTabs(content.slice(0, column - 1));
	const gutterPrefix = styles.lineNumber(`${" ".repeat(padding)}|`);
	return `${SNIPPET_INDENT}${gutterPrefix} ${" ".repeat(beforeColumn.length)}${styles.status.fail("^")}`;
}

// `tsLine`/`tsPath` arrive already narrowed from the caller — the only caller
// branches on them to pick between this and the Luau-only rendering, so
// re-checking them here would be an unreachable guard.
function tsSnippetLines({
	loc,
	showLuau,
	styles,
	tsLine,
	tsPath,
	useColor,
}: TsSnippetOptions): Array<string> {
	const tsSnippet = getSourceSnippet({
		column: loc.tsColumn,
		context: 2,
		filePath: tsPath,
		line: tsLine,
		sourceContent: loc.sourceContent,
	});
	if (tsSnippet === undefined) {
		return [];
	}

	// The label only earns its space when the Luau snippet follows it.
	const language = showLuau ? "TypeScript" : undefined;
	return ["", formatSourceSnippet(tsSnippet, tsPath, { language, styles, useColor })];
}

function luauSnippetLines(
	loc: MappedLocation,
	styles: Styles,
	useColor: boolean,
	language?: string,
): Array<string> {
	const luauSnippet = getSourceSnippet({
		context: 2,
		filePath: loc.luauPath,
		line: loc.luauLine,
	});
	if (luauSnippet === undefined) {
		return [];
	}

	return ["", formatSourceSnippet(luauSnippet, loc.luauPath, { language, styles, useColor })];
}

function formatMappedLocationSnippets(
	loc: MappedLocation,
	showLuau: boolean,
	styles: Styles,
	useColor: boolean,
): Array<string> {
	const { tsLine, tsPath } = loc;

	// Luau-only: show the Luau snippet without a language label
	if (tsPath === undefined || tsLine === undefined) {
		return luauSnippetLines(loc, styles, useColor);
	}

	// When TS fields are present, show TypeScript snippet (+ optional Luau)
	const snippets = tsSnippetLines({ loc, showLuau, styles, tsLine, tsPath, useColor });
	if (showLuau) {
		snippets.push(...luauSnippetLines(loc, styles, useColor, "Luau"));
	}

	return snippets;
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
