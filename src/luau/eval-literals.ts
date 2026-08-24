import type { AstExpr, AstExprTableItem, AstStatBlock } from "@isentinel/luau-ast/ast";

export type LuauLiteral =
	| Array<LuauLiteral>
	| boolean
	| LuauLiteralTable
	| number
	| string
	| undefined;

export interface LuauLiteralTable {
	[key: string]: LuauLiteral;
}

/**
 * Evaluate the first return expression in a parsed root block, supporting
 * only literal values (string, boolean, number, nil, table, cast).
 *
 * @param root - The parsed root block.
 * @returns The evaluated literal.
 */
export function evalLuauReturnLiterals(root: AstStatBlock): LuauLiteral {
	const returnStatement = root.body.find((statement) => statement.type === "AstStatReturn");
	if (returnStatement === undefined) {
		throw new Error("Config file has no return statement");
	}

	const [first] = returnStatement.list;
	if (first === undefined) {
		throw new Error("Return statement has no expressions");
	}

	return evalExpr(first);
}

function evalExpr(node: AstExpr): LuauLiteral {
	let current = node;
	while (current.type === "AstExprTypeAssertion") {
		current = current.expr;
	}

	if (current.type === "AstExprConstantBool" || current.type === "AstExprConstantNumber") {
		return current.value;
	}

	if (current.type === "AstExprConstantString") {
		return current.value;
	}

	if (current.type === "AstExprTable") {
		return evalTable(current.items);
	}

	return undefined;
}

function evalTable(items: Array<AstExprTableItem>): LuauLiteral {
	if (items.length === 0) {
		return {};
	}

	const [first] = items;
	if (first?.kind === "item") {
		return items.map((item) => evalExpr(item.value));
	}

	const result: LuauLiteralTable = {};
	for (const item of items) {
		if (item.kind !== "record" || item.key?.type !== "AstExprConstantString") {
			continue;
		}

		result[item.key.value] = evalExpr(item.value);
	}

	return result;
}
