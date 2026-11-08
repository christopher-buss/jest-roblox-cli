import { assert } from "vitest";

import type { CstCall, CstExpr, CstNumber, CstRoot, CstStat } from "#src/cst.ts";

export function numberNode(): CstNumber {
	return {
		location: { beginColumn: 1, beginLine: 1, endColumn: 2, endLine: 1 },
		token: { leading: [], text: "1", trailing: [] },
		type: "Number",
	};
}

export function lastStatementCall(root: CstRoot): CstCall {
	const expression = statementExpression(root.body.body.at(-1));
	assert(expression?.type === "Call", "the last statement holds no call");
	return expression;
}

function statementExpression(statement: CstStat | undefined): CstExpr | undefined {
	if (statement?.type === "Return") {
		return statement.values[0]?.node;
	}

	return statement?.type === "ExprStat" ? statement.expr : undefined;
}
