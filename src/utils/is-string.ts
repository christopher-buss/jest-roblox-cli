/**
 * Type predicate that narrows an unknown value to `string`. Handy as a
 * `filter` argument: `unknown[].filter(isString)` yields `string[]` without a
 * cast, which is how config readers pull string lists out of parsed JSON or
 * Luau tables.
 */
export function isString(value: unknown): value is string {
	return typeof value === "string";
}
