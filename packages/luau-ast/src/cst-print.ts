import assert from "node:assert";

import type { CstEdits, Removal, Replacement } from "./cst-edit.ts";
import { isCstNode, tokenBounds, walkCst } from "./cst.ts";
import type { CstNode, CstRoot, Token, TokenBounds, Trivia } from "./cst.ts";
import type { SourceBytes } from "./source-bytes.ts";

/**
 * A position in printed or original text: 1-based line, 0-based UTF-16
 * column.
 */
export interface CstPosition {
	column: number;
	line: number;
}

/** One printed token traced back to where it came from. */
export interface CstSourcemapSegment {
	generated: CstPosition;
	original: CstPosition;
}

export interface PrintedCst {
	code: string;
	segments: Array<CstSourcemapSegment>;
}

export interface PrintOptions {
	/** Replacements to print in place of nodes. */
	edits?: CstEdits | undefined;
	/** The indexed source the tree was parsed from; needed for segments. */
	source?: SourceBytes;
}

/** Appends text while tracking where the next character lands. */
interface Writer {
	code: () => string;
	position: () => CstPosition;
	write: (text: string) => void;
}

/** One print pass: where output stands, and what to consult on the way. */
interface Printer extends PrintOptions {
	segments: Array<CstSourcemapSegment>;
	writer: Writer;
}

interface Replaced {
	replacement: Replacement;
	target: CstNode;
}

/**
 * Print a tree back to source: for each token in lexical order, its leading
 * trivia, its text, then its trailing trivia. A tree straight from the parser
 * prints byte-identical to its source. Before printing a node the printer
 * consults `edits` and prints the registered replacement in its place.
 *
 * @param root - The tree to print.
 * @param edits - Replacements to print in place of nodes.
 * @returns The printed source.
 */
export function printCst(root: CstRoot, edits?: CstEdits): string {
	return print(root, { edits }).code;
}

/**
 * {@link printCst} with one sourcemap segment per printed token, from the
 * token's original position with its byte column restated in UTF-16 units.
 *
 * @param root - The tree to print.
 * @param options - The indexed source, and the replacements.
 * @returns The printed source and its segments.
 */
export function printCstMapped(
	root: CstRoot,
	options: PrintOptions & { source: SourceBytes },
): PrintedCst {
	return print(root, options);
}

function createWriter(): Writer {
	let code = "";
	let line = 1;
	let column = 0;

	return {
		code: () => code,
		position: () => ({ column, line }),
		write: (text) => {
			code += text;
			let lastNewline = -1;
			for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) {
				line += 1;
				lastNewline = at;
			}

			column = lastNewline === -1 ? column + text.length : text.length - lastNewline - 1;
		},
	};
}

function print(root: CstRoot, options: PrintOptions): PrintedCst {
	const printer = { ...options, segments: [], writer: createWriter() } satisfies Printer;
	walk(printer, root);
	return { code: printer.writer.code(), segments: printer.segments };
}

function writeTrivia(printer: Printer, items: Array<Trivia>): void {
	for (const trivia of items) {
		printer.writer.write(trivia.text);
	}
}

function emitToken(printer: Printer, token: Token): void {
	writeTrivia(printer, token.leading);
	if (printer.source !== undefined && token.origin !== undefined && token.text.length > 0) {
		const { beginColumn, beginLine } = token.origin;
		printer.segments.push({
			generated: printer.writer.position(),
			original: {
				column: printer.source.toUtf16Column(beginLine, beginColumn) - 1,
				line: beginLine,
			},
		});
	}

	printer.writer.write(token.text);
	writeTrivia(printer, token.trailing);
}

/** The tree walk; a replaced node prints its replacement and is not entered. */
function walk(printer: Printer, value: unknown): void {
	walkCst(value, {
		onNode: (target) => {
			const replacement = printer.edits?.replacementFor(target);
			if (replacement === undefined) {
				return;
			}

			printReplacement(printer, { replacement, target });
			return true;
		},
		onToken: (token) => {
			emitToken(printer, token);
		},
	});
}

function isNewlineWhitespace(trivia: Trivia): boolean {
	return trivia.kind === "whitespace" && trivia.text.includes("\n");
}

/**
 * Print a removal. The node held a whole line when nothing but indentation
 * precedes it on its line and a newline follows it; then the indentation
 * and the newline go with it. Otherwise the whitespace on both sides stays,
 * so what shared the line with it keeps its spacing.
 */
function printRemoval(printer: Printer, removal: Removal, { first, last }: TokenBounds): void {
	const leading = removal.preserveLeading ? first.leading : [];
	const lineStart = leading.findLastIndex(isNewlineWhitespace) + 1;
	const indentation = leading.slice(lineStart);
	writeTrivia(printer, leading.slice(0, lineStart));

	const [firstTrailing] = last.trailing;
	const isWholeLine =
		printer.writer.position().column === 0 &&
		indentation.every((trivia) => trivia.kind === "whitespace") &&
		(firstTrailing === undefined || isNewlineWhitespace(firstTrailing));
	if (isWholeLine) {
		return;
	}

	writeTrivia(printer, indentation);
	writeTrivia(printer, last.trailing);
}

function printReplacement(printer: Printer, { replacement, target }: Replaced): void {
	const bounds = tokenBounds(target);
	assert(bounds !== undefined, "a replaced node has no tokens");
	const { first, last } = bounds;
	if ("remove" in replacement) {
		printRemoval(printer, replacement, bounds);
		return;
	}

	if (isCstNode(replacement)) {
		writeTrivia(printer, first.leading);
		walk(printer, replacement);
		writeTrivia(printer, last.trailing);
		return;
	}

	if (replacement.preserveLeading !== false) {
		writeTrivia(printer, first.leading);
	}

	printer.writer.write(replacement.text);
	if (replacement.preserveTrailing !== false) {
		writeTrivia(printer, last.trailing);
	}
}
