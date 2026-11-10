import type { SourceSnippet } from "../source-mapper/index.ts";
import type { Styles } from "../terminal/palette.ts";
import { makeRelative } from "./shared.ts";

const SNIPPET_INDENT = "\t";

/**
 * Inputs of `formatSourceSnippet`.
 */
export interface SourceSnippetOptions {
	/**
	 * Path shown in the location header and used to pick syntax highlighting.
	 */
	filePath: string;
	/**
	 * Language label after the location; omitted when absent.
	 */
	language?: string | undefined;
	/**
	 * Root the header path is shown relative to; the full path when absent.
	 */
	rootDir?: string | undefined;
	/**
	 * Lines to show, with the failure line and column.
	 */
	snippet: SourceSnippet;
	/**
	 * Palette to render with; its highlighter, when set, colors the code.
	 */
	styles: Styles;
}

interface FormatLocationHeaderOptions {
	filePath: string;
	language: string | undefined;
	snippet: SourceSnippet;
	styles: Styles;
}

interface FormatCaretLineOptions {
	column: number;
	content: string;
	padding: number;
	styles: Styles;
}

/**
 * Render a source snippet with a header, line numbers and a caret.
 * @param options - Snippet, its path, language label and palette.
 * @returns The rendered snippet.
 */
export function formatSourceSnippet({
	filePath,
	language,
	rootDir,
	snippet,
	styles,
}: SourceSnippetOptions): string {
	const shownPath = rootDir === undefined ? filePath : makeRelative(filePath, rootDir);
	const lines = [formatLocationHeader({ filePath: shownPath, language, snippet, styles })];

	const maxLineNumber = Math.max(...snippet.lines.map((line) => line.num));
	const padding = String(maxLineNumber).length;

	for (const line of snippet.lines) {
		const prefix = `${String(line.num).padStart(padding)}|`;
		const expandedContent = expandTabs(line.content);
		const highlighted = styles.highlight?.(filePath, expandedContent) ?? expandedContent;
		lines.push(`${SNIPPET_INDENT}${styles.lineNumber(prefix)} ${highlighted}`);

		if (line.num === snippet.failureLine && snippet.column !== undefined) {
			lines.push(
				formatCaretLine({ column: snippet.column, content: line.content, padding, styles }),
			);
		}
	}

	return lines.join("\n");
}

function formatLocationHeader({
	filePath,
	language,
	snippet,
	styles,
}: FormatLocationHeaderOptions): string {
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

function formatCaretLine({ column, content, padding, styles }: FormatCaretLineOptions): string {
	const beforeColumn = expandTabs(content.slice(0, column - 1));
	const gutterPrefix = styles.lineNumber(`${" ".repeat(padding)}|`);
	return `${SNIPPET_INDENT}${gutterPrefix} ${" ".repeat(beforeColumn.length)}${styles.status.fail("^")}`;
}
