import assert from "node:assert";
import { Buffer } from "node:buffer";

import type { LuauSpan } from "./ast.ts";
import { createUtf8OffsetMap } from "./utf8-offsets.ts";

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
 * byte offsets against the UTF-8 encoding of the text — never UTF-16 indexes
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
	 * character boundaries — parser spans always do.
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
	toUtf16Column: (line: number, column: number) => number;
}

/**
 * The bytes that end or pad a line. Every source scan classifies against
 * these, whatever grammar it reads, so they live here; a byte that means
 * something only to one grammar belongs to the scanner that knows it.
 *
 * A byte this low can only be the character itself — a multi-byte UTF-8
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
		slice: (start, end) => decode(buffer, { end, start }),
		sliceSpan: (span) => decode(buffer, spanToByteRange(span, lineStartOffset)),
		spanToRange: (span) => spanToByteRange(span, lineStartOffset),
		text: source,
		toUtf16Column: createColumnConverter((line) => {
			return decode(buffer, { end: lineEndOffset(line), start: lineStartOffset(line) });
		}),
	};
}

/**
 * A byte-column-to-UTF-16-column converter over the lines `readLine` returns.
 * Each line's converter is built on first use and only where the two units
 * disagree: a source is overwhelmingly ASCII, and a caller converting columns
 * walks a handful of lines rather than the whole file.
 *
 * @param readLine - Reads a 1-based line's text, trailing newline and all.
 * @returns The converter.
 */
function createColumnConverter(
	readLine: (line: number) => string,
): (line: number, column: number) => number {
	const convertersByLine = new Map<number, (column: number) => number>();

	function converterFor(line: number): (column: number) => number {
		// The trailing newline stays in the mapped text: it changes no column
		// before it, and dropping a carriage return would shift every column
		// past it, because the parser counts bytes from the start of the line.
		const text = readLine(line);
		if (Buffer.byteLength(text, "utf-8") === text.length) {
			return (column) => column;
		}

		const offsets = createUtf8OffsetMap(text);
		// Both columns count from 1 and the offset map from 0.
		return (column) => offsets.toUtf16(column - 1) + 1;
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

/**
 * Decode the bytes of `buffer` the range covers as text.
 *
 * @param buffer - The UTF-8 encoded source.
 * @param range - The bytes to decode.
 * @returns The decoded text.
 */
function decode(buffer: Buffer, range: ByteRange): string {
	return buffer.subarray(range.start, range.end).toString("utf-8");
}

/**
 * Resolve a parser span against the line the offsets come from.
 *
 * @param span - The span to resolve, 1-based with an exclusive end column.
 * @param lineStartOffset - See {@link SourceBytes.lineStartOffset}.
 * @returns The byte range the span covers.
 */
function spanToByteRange(span: LuauSpan, lineStartOffset: (line: number) => number): ByteRange {
	return {
		end: lineStartOffset(span.endLine) + span.endColumn - 1,
		start: lineStartOffset(span.beginLine) + span.beginColumn - 1,
	};
}

/**
 * Scan `buffer` for the byte offset each 1-based line starts at.
 *
 * @param buffer - The UTF-8 encoded source.
 * @returns One start offset per line, in line order.
 */
function scanLineStarts(buffer: Buffer): Array<number> {
	const lineStarts = [0];
	let newlineOffset = buffer.indexOf(BYTE_LINE_FEED);
	while (newlineOffset !== -1) {
		lineStarts.push(newlineOffset + 1);
		newlineOffset = buffer.indexOf(BYTE_LINE_FEED, newlineOffset + 1);
	}

	return lineStarts;
}

/**
 * The 1-based line a byte offset sits on: the last line starting at or before
 * it. Binary search, because a caller resolving a span walks no lines at all
 * and the file may hold thousands.
 *
 * @param offset - The 0-based byte offset.
 * @param lineStarts - One start offset per line, in line order.
 * @returns The 1-based line.
 */
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

/**
 * The 1-based line and 1-based byte column a byte offset sits at.
 *
 * @param offset - The 0-based byte offset.
 * @param lineStarts - One start offset per line, in line order.
 * @returns The position.
 */
function positionAt(offset: number, lineStarts: Array<number>): { column: number; line: number } {
	const line = lineAt(offset, lineStarts);
	const start = lineStarts[line - 1];
	assert(start !== undefined, "lineAt answers a line inside the array");

	return { column: offset - start + 1, line };
}

/**
 * Resolve a byte range back to the span it covers.
 *
 * @param range - The byte range to restate.
 * @param lineStarts - One start offset per line, in line order.
 * @returns The span the range covers.
 */
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
