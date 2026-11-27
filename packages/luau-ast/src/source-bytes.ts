import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import type { LuauSpan, Utf16Column, Utf16Span } from "./ast-types.ts";
import { createUtf8OffsetMap } from "./utf-8-offsets.ts";

/** Byte-offset range within a source file. Start inclusive, end exclusive. */
export interface ByteRange {
	/** End byte offset (exclusive). */
	end: number;
	/** Start byte offset (inclusive). */
	start: number;
}

/**
 * A Luau source indexed for byte-offset math. Every position the parser
 * reports counts UTF-8 bytes (Luau's convention), so all offsets here are
 * byte offsets against the UTF-8 encoding of the text, never UTF-16 indexes
 * into the JavaScript string.
 */
export interface SourceBytes {
	/** The byte at a 0-based offset, or `undefined` past the end. */
	byteAt: (offset: number) => number | undefined;
	/** UTF-8 byte length of the source. */
	byteLength: number;
	/**
	 * Byte offset one past a 1-based line's last byte: the start of the next
	 * line (so a trailing newline is inside the line), or the source length on
	 * the final line.
	 */
	lineEndOffset: (line: number) => number;
	/** 0-based byte offset where a 1-based line starts. */
	lineStartOffset: (line: number) => number;
	/**
	 * Restate a byte range as a parser span. Each offset answers the last line
	 * starting at or before it, so an offset on a line start reads as column 1
	 * of that line, never as one past the previous line's last byte. The two
	 * spell the same offset, so {@link SourceBytes.spanToRange} round-trips a
	 * range; a span that ends one past a line's last byte does not survive the
	 * other direction.
	 */
	rangeToSpan: (range: ByteRange) => LuauSpan;
	/**
	 * Decode the bytes in `[start, end)` as text. Offsets must sit on
	 * character boundaries; parser spans always do.
	 */
	slice: (start: number, end: number) => string;
	/**
	 * The text a parser span covers: {@link SourceBytes.spanToRange} and
	 * {@link SourceBytes.slice} in one call, which is how a caller holding an
	 * index reads a node back out of its source.
	 */
	sliceSpan: (span: LuauSpan) => string;
	/** Convert a parser span (1-based line/column) to a byte range. */
	spanToRange: (span: LuauSpan) => ByteRange;
	/** The source text this index was built from. */
	text: string;
	/**
	 * Restate a 1-based byte column on a 1-based line as a 1-based UTF-16
	 * column, so it can index the JavaScript string for that line. An end
	 * column one past the line's last byte answers one past its last UTF-16
	 * unit.
	 */
	toUtf16Column: (line: number, column: number) => Utf16Column;
	/** {@link SourceBytes.toUtf16Column} over both ends of a parser span. */
	toUtf16Span: (span: LuauSpan) => Utf16Span;
}

/**
 * The bytes that end or pad a line. Every source scan classifies against
 * these, whatever grammar it reads, so they live here; a byte that means
 * something only to one grammar belongs to the scanner that knows it.
 *
 * A byte this low can only be the character itself: a multi-byte UTF-8
 * sequence never contains one.
 */
export const BYTE_CARRIAGE_RETURN = 0x0d;
export const BYTE_LINE_FEED = 0x0a;
export const BYTE_SPACE = 0x20;
export const BYTE_TAB = 0x09;

/**
 * Index a Luau source for byte-offset math against parser spans.
 *
 * @param source - The source text to index.
 * @returns The indexed source.
 */
export function indexSourceBytes(source: string): SourceBytes {
	const buffer = Buffer.from(source, "utf-8");
	const lineStarts = scanLineStarts(buffer);
	const slice = createSlicer(buffer, source);

	function lineStartOffset(line: number): number {
		const start = lineStarts[line - 1];
		assert(start !== undefined, `line ${String(line)} is outside the source`);
		return start;
	}

	function lineEndOffset(line: number): number {
		return lineStarts[line] ?? buffer.length;
	}

	return {
		byteAt: (offset) => buffer[offset],
		byteLength: buffer.length,
		lineEndOffset,
		lineStartOffset,
		rangeToSpan: (range) => byteRangeToSpan(range, lineStarts),
		slice,
		sliceSpan: (span) => {
			const range = spanToByteRange(span, lineStartOffset);
			return slice(range.start, range.end);
		},
		spanToRange: (span) => spanToByteRange(span, lineStartOffset),
		text: source,
		...createUtf16Conversion({ buffer, lineEndOffset, lineStartOffset, source }),
	};
}

function asUtf16Column(column: number): Utf16Column {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
	return column as Utf16Column;
}

function createColumnConverter(
	readLine: (line: number) => string,
): (line: number, column: number) => Utf16Column {
	const convertersByLine = new Map<number, (column: number) => Utf16Column>();

	function converterFor(line: number): (column: number) => Utf16Column {
		// The trailing newline stays in the mapped text: it changes no column
		// before it, and dropping a carriage return would shift every column
		// past it, because the parser counts bytes from the start of the line.
		const text = readLine(line);
		if (Buffer.byteLength(text, "utf-8") === text.length) {
			return asUtf16Column;
		}

		const offsets = createUtf8OffsetMap(text);
		return (column) => asUtf16Column(offsets.toUtf16(column - 1) + 1);
	}

	return (line, column) => {
		let convert = convertersByLine.get(line);
		if (convert === undefined) {
			convert = converterFor(line);
			convertersByLine.set(line, convert);
		}

		return convert(column);
	};
}

function decode(buffer: Buffer, range: ByteRange): string {
	return buffer.subarray(range.start, range.end).toString("utf-8");
}

function createUtf16Conversion({
	buffer,
	lineEndOffset,
	lineStartOffset,
	source,
}: {
	buffer: Buffer;
	lineEndOffset: (line: number) => number;
	lineStartOffset: (line: number) => number;
	source: string;
}): Pick<SourceBytes, "toUtf16Column" | "toUtf16Span"> {
	const toUtf16Column =
		buffer.length === source.length
			? (_line: number, column: number) => asUtf16Column(column)
			: createColumnConverter((line) => {
					return decode(buffer, {
						end: lineEndOffset(line),
						start: lineStartOffset(line),
					});
				});

	return {
		toUtf16Column,
		toUtf16Span: (span) => {
			return {
				beginColumn: toUtf16Column(span.beginLine, span.beginColumn),
				beginLine: span.beginLine,
				endColumn: toUtf16Column(span.endLine, span.endColumn),
				endLine: span.endLine,
			};
		},
	};
}

function createSlicer(buffer: Buffer, source: string): SourceBytes["slice"] {
	if (buffer.length === source.length) {
		return (start, end) => source.slice(start, end);
	}

	return (start, end) => decode(buffer, { end, start });
}

function spanToByteRange(span: LuauSpan, lineStartOffset: (line: number) => number): ByteRange {
	return {
		end: lineStartOffset(span.endLine) + span.endColumn - 1,
		start: lineStartOffset(span.beginLine) + span.beginColumn - 1,
	};
}

function scanLineStarts(buffer: Buffer): Array<number> {
	const lineStarts = [0];
	let newlineOffset = buffer.indexOf(BYTE_LINE_FEED);
	while (newlineOffset !== -1) {
		lineStarts.push(newlineOffset + 1);
		newlineOffset = buffer.indexOf(BYTE_LINE_FEED, newlineOffset + 1);
	}

	return lineStarts;
}

function lineAt(offset: number, lineStarts: Array<number>): number {
	let low = 0;
	let high = lineStarts.length - 1;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		const start = lineStarts[middle];
		assert(start !== undefined, "middle sits inside the array");
		if (start <= offset) {
			low = middle;
		} else {
			high = middle - 1;
		}
	}

	return low + 1;
}

function positionAt(offset: number, lineStarts: Array<number>): { column: number; line: number } {
	const line = lineAt(offset, lineStarts);
	const start = lineStarts[line - 1];
	assert(start !== undefined, "lineAt answers a line inside the array");

	return { column: offset - start + 1, line };
}

function byteRangeToSpan(range: ByteRange, lineStarts: Array<number>): LuauSpan {
	const begin = positionAt(range.start, lineStarts);
	const end = positionAt(range.end, lineStarts);

	return {
		beginColumn: begin.column,
		beginLine: begin.line,
		endColumn: end.column,
		endLine: end.line,
	};
}
