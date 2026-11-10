import type { Utf16Column, Utf16Span } from "@isentinel/luau-ast";
import { indexSourceBytes } from "@isentinel/luau-ast";
import type { LuauSpan } from "@isentinel/luau-ast/ast";

export function asciiColumn(column: number): Utf16Column {
	return indexSourceBytes("").toUtf16Column(1, column);
}

export function asciiSpan(span: LuauSpan): Utf16Span {
	return indexSourceBytes("").toUtf16Span(span);
}
