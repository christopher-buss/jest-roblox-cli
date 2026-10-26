import type {
	AstExpr,
	AstExprCall,
	AstExprGroup,
	AstExprTableItem,
	AstExprTypeAssertion,
	AstStatBlock,
} from "@isentinel/luau-ast/ast";

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

export type LuauStaticEvaluation =
	| { readonly kind: "unreadable"; readonly line: number; readonly syntax: string }
	| { readonly kind: "value"; readonly value: LuauLiteral };

type DefineConfigCall = AstExprCall & { args: [AstExpr] };

type PassThroughExpression = AstExprGroup | AstExprTypeAssertion | DefineConfigCall;

type UnreadableExpressionType = Exclude<
	AstExpr["type"],
	| "AstExprConstantBool"
	| "AstExprConstantNil"
	| "AstExprConstantNumber"
	| "AstExprConstantString"
	| "AstExprGroup"
	| "AstExprTable"
	| "AstExprTypeAssertion"
>;

const UNREADABLE_SYNTAX = {
	AstExprBinary: "an operator",
	AstExprCall: "a function call",
	AstExprFunction: "a function",
	AstExprGlobal: "a global variable",
	AstExprIfElse: "an if-expression",
	AstExprIndexExpr: "an index",
	AstExprIndexName: "an index",
	AstExprInstantiate: "an explicit type instantiation",
	AstExprInterpString: "an interpolated string",
	AstExprLocal: "a local variable",
	AstExprUnary: "an operator",
	AstExprVarargs: "a vararg",
} satisfies Record<UnreadableExpressionType, string>;

export function evalLuauReturnLiterals(root: AstStatBlock): LuauStaticEvaluation {
	for (const statement of root.body) {
		if (statement.type === "AstStatReturn") {
			const [first] = statement.list;
			return first === undefined ? { kind: "value", value: undefined } : evalExpr(first);
		}
	}

	return { kind: "value", value: undefined };
}

function isDefineConfigCall(call: AstExprCall): call is DefineConfigCall {
	if (call.self || call.args.length !== 1) {
		return false;
	}

	const { func } = call;
	return (
		(func.type === "AstExprGlobal" && func.global === "defineConfig") ||
		(func.type === "AstExprLocal" && func.local.name === "defineConfig") ||
		(func.type === "AstExprIndexName" &&
			func.index === "defineConfig" &&
			(func.expr.type === "AstExprLocal" || func.expr.type === "AstExprGlobal"))
	);
}

function isPassThrough(node: AstExpr): node is PassThroughExpression {
	return (
		node.type === "AstExprTypeAssertion" ||
		node.type === "AstExprGroup" ||
		(node.type === "AstExprCall" && isDefineConfigCall(node))
	);
}

function evalExpr(expression: AstExpr): LuauStaticEvaluation {
	let node = expression;
	while (isPassThrough(node)) {
		node = node.type === "AstExprCall" ? node.args[0] : node.expr;
	}

	if (
		node.type === "AstExprConstantBool" ||
		node.type === "AstExprConstantNumber" ||
		node.type === "AstExprConstantString"
	) {
		return { kind: "value", value: node.value };
	}

	if (node.type === "AstExprConstantNil") {
		return { kind: "value", value: undefined };
	}

	if (node.type === "AstExprTable") {
		const [first] = node.items;
		return first?.kind === "item" ? evalList(node.items) : evalRecord(node.items);
	}

	return {
		kind: "unreadable",
		line: node.location.beginLine,
		syntax: UNREADABLE_SYNTAX[node.type],
	};
}

function mixedTable(item: AstExprTableItem): LuauStaticEvaluation {
	return {
		kind: "unreadable",
		line: item.value.location.beginLine,
		syntax: "a table that mixes list and record entries",
	};
}

function evalList(items: Array<AstExprTableItem>): LuauStaticEvaluation {
	const values: Array<LuauLiteral> = [];
	for (const item of items) {
		if (item.key !== undefined) {
			return mixedTable(item);
		}

		const entry = evalExpr(item.value);
		if (entry.kind === "unreadable") {
			return entry;
		}

		values.push(entry.value);
	}

	return { kind: "value", value: values };
}

function evalRecord(items: Array<AstExprTableItem>): LuauStaticEvaluation {
	const record: LuauLiteralTable = {};
	for (const item of items) {
		const { key } = item;
		if (key === undefined) {
			return mixedTable(item);
		}

		if (key.type !== "AstExprConstantString") {
			return {
				kind: "unreadable",
				line: key.location.beginLine,
				syntax: "a table key that is not a string literal",
			};
		}

		const entry = evalExpr(item.value);
		if (entry.kind === "unreadable") {
			return entry;
		}

		if (entry.value !== undefined) {
			record[key.value] = entry.value;
		}
	}

	return { kind: "value", value: record };
}
