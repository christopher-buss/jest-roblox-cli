/**
 * Type predicate that narrows an unknown value to `Record<string, string>`.
 * Rejects null, arrays, symbol-keyed objects, and any object whose values are
 * not all strings. The branded shape carries the invariant at the type level
 * — call sites don't need a manual cast or eslint-disable to use the result.
 */
export function isStringRecord(value: unknown): value is Record<string, string> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}

	if (Object.getOwnPropertySymbols(value).length > 0) {
		return false;
	}

	const record = value as Record<string, unknown>;
	return Object.getOwnPropertyNames(record).every((key) => typeof record[key] === "string");
}
