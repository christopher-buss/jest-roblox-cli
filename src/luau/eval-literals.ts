/**
 * Evaluate the first return expression in a Lute-stripped AST root block,
 * supporting only literal values (string, boolean, number, nil, table, cast).
 *
 * Accepts `unknown` and narrows safely — no type casts on JSON.parse needed.
 */
export function evalLuauReturnLiterals(root: unknown): unknown {
	if (!isObject(root) || !Array.isArray(root["statements"])) {
		throw new Error("Config file has no return statement");
	}

	const returnStat = root["statements"].find(
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
