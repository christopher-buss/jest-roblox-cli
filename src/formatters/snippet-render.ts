import type { SourceSnippet } from "../source-mapper/index.ts";
import { highlightCode } from "../utils/colors.ts";
import { createStyles, type Styles } from "./styles.ts";

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
	 * Lines to show, with the failure line and column.
	 */
	snippet: SourceSnippet;
	/**
	 * Palette to render with; built from `useColor` when absent.
	 */
	styles?: Styles | undefined;
	/**
	 * Emit ANSI color and syntax highlighting; defaults to true.
	 */
	useColor?: boolean | undefined;
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
 * Render a source snippet: a location header, numbered lines, and a caret under the failure column.
 * @param options - Snippet, its path, language label and palette.
 * @returns The rendered snippet.
 */
export function formatSourceSnippet({
	filePath,
	language,
	snippet,
	styles: snippetStyles,
	useColor: isColorEnabled = true,
}: SourceSnippetOptions): string {
	const styles = snippetStyles ?? createStyles(isColorEnabled);
	const lines = [formatLocationHeader({ filePath, language, snippet, styles })];

	// Determine padding for line numbers
	const maxLineNumber = Math.max(...snippet.lines.map((line) => line.num));
	const padding = String(maxLineNumber).length;

	for (const line of snippet.lines) {
		const prefix = `${String(line.num).padStart(padding)}|`;
		const expandedContent = expandTabs(line.content);
		const highlighted = highlightSyntax({
			code: expandedContent,
			filePath,
			useColor: isColorEnabled,
		});
		lines.push(`${SNIPPET_INDENT}${styles.lineNumber(prefix)} ${highlighted}`);

		if (line.num === snippet.failureLine && snippet.column !== undefined) {
			lines.push(
				formatCaretLine({ column: snippet.column, content: line.content, padding, styles }),
			);
		}
	}

	return lines.join("\n");
}

/**
 * Location header: ❯ path:line:col  (Language).
 * @param options - Snippet, its path, language label and palette.
 * @returns The header line.
 */
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

function highlightSyntax({
	code,
	filePath,
	useColor,
}: {
	code: string;
	filePath: string;
	useColor: boolean;
}): string {
	if (!useColor) {
		return code;
	}

	return highlightCode(filePath, code);
}

/**
 * Tabs before the column widen the caret's offset, so the prefix is expanded
 * the same way the rendered line was.
 * @param options - Failure line content, column, gutter width and palette.
 * @returns Gutter-aligned `^` under the failure column.
 */
function formatCaretLine({ column, content, padding, styles }: FormatCaretLineOptions): string {
	const beforeColumn = expandTabs(content.slice(0, column - 1));
	const gutterPrefix = styles.lineNumber(`${" ".repeat(padding)}|`);
	return `${SNIPPET_INDENT}${gutterPrefix} ${" ".repeat(beforeColumn.length)}${styles.status.fail("^")}`;
}
