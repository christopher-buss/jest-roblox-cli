import type { AstStatBlock } from "@isentinel/luau-ast";

/**
 * Evaluate the first return expression in a Lute-stripped AST root block,
 * supporting only literal values (string, boolean, number, nil, table, cast).
 *
 * Accepts an `AstStatBlock` and narrows internally via type guards. Callers
 * that start from `JSON.parse` output narrow via `isAstStatBlock` first —
 * the type predicate carries the shape invariant without a cast.
 */
export function evalLuauReturnLiterals(root: AstStatBlock): unknown {
	const block = root as unknown as Record<string, unknown>;
	if (!Array.isArray(block["statements"])) {
		throw new Error("Config file has no return statement");
	}

	const returnStat = block["statements"].find(
		(stat: unknown) => isObject(stat) && stat["tag"] === "return",
	);

	if (!isObject(returnStat) || !Array.isArray(returnStat["expressions"])) {
		throw new Error("Config file has no return statement");
	}

	const first: unknown = returnStat["expressions"][0];
	if (!isObject(first) || !("node" in first)) {
		throw new Error("Return statement has no expressions");
	}

	return evalExpr(first["node"]);
}

/**
 * Type predicate for narrowing `JSON.parse` output to `AstStatBlock`. The
 * predicate exempts the call from `halcyon/no-json-value-erasure` and brands
 * the validated value at the type level — production callers don't need a
 * runtime arktype schema or a manual cast to bridge JSON to AST types.
 */
export function isAstStatBlock(value: unknown): value is AstStatBlock {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		(value as Record<string, unknown>)["tag"] === "block"
	);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function evalExpr(node: unknown): unknown {
	if (!isObject(node)) {
		return undefined;
	}

	let current = node;

	while (current["tag"] === "cast" && isObject(current["operand"])) {
		current = current["operand"];
	}

	const { tag } = current;

	if (tag === "boolean" || tag === "number") {
		return current["value"];
	}

	if (tag === "string") {
		return current["text"];
	}

	if (tag === "table" && Array.isArray(current["entries"])) {
		return evalTable(current["entries"]);
	}

	return undefined;
}

function evalTable(entries: Array<unknown>): unknown {
	if (entries.length === 0) {
		return {};
	}

	const first: unknown = entries[0];
	if (isObject(first) && first["kind"] === "list") {
		return entries.map((entry) => (isObject(entry) ? evalExpr(entry["value"]) : undefined));
	}

	const result: Record<string, unknown> = {};
	for (const entry of entries) {
		if (!isObject(entry) || entry["kind"] !== "record") {
			continue;
		}

		const { key, value } = entry;
		if (isObject(key) && typeof key["text"] === "string") {
			result[key["text"]] = evalExpr(value);
		}
	}

	return result;
}
