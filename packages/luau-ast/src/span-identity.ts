import type { LuauSpan } from "./ast.ts";

/**
 * Identity key for a binding declaration, derived from its span. The parser
 * duplicates the declaration object at every reference (it round-trips
 * through JSON), so declaration position is the only stable identity.
 *
 * @param span - The declaration's span.
 * @returns A key unique to the declaration site.
 */
export function bindingKey(span: LuauSpan): string {
	return `${String(span.beginLine)}:${String(span.beginColumn)}`;
}
