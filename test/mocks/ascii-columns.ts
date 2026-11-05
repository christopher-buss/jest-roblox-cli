import type { Utf16Column, Utf16Span } from "@isentinel/luau-ast";
import { indexSourceBytes } from "@isentinel/luau-ast";
import type { LuauSpan } from "@isentinel/luau-ast/ast";

/**
 * A column on an all-ASCII line, where a byte and a UTF-16 unit coincide.
 * @param column - Column on the line.
 * @returns The same column as a UTF-16 column.
 */
export function asciiColumn(column: number): Utf16Column {
	return indexSourceBytes("").toUtf16Column(1, column);
}

/**
 * A span on all-ASCII lines, where a byte and a UTF-16 unit coincide.
 * @param span - Luau span.
 * @returns The same span in UTF-16 columns.
 */
export function asciiSpan(span: LuauSpan): Utf16Span {
	return indexSourceBytes("").toUtf16Span(span);
}
