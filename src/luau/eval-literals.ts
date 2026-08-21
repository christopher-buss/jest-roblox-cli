import type { AstStat, AstStatBlock } from "@isentinel/luau-ast";

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

/** Any value a Lute AST node can hold: a child node, a list, or a scalar. */
type AstMember = Array<AstMember> | AstNode | boolean | number | string | undefined;

interface AstNode {
	readonly [key: string]: AstMember;
}

/**
 * Evaluate the first return expression in a Lute-stripped AST root block,
 * supporting only literal values (string, boolean, number, nil, table, cast).
 *
 * Accepts an `AstStatBlock` and narrows internally via type guards. Callers
 * that start from `JSON.parse` output narrow via `isAstStatBlock` first —
 * the type predicate carries the shape invariant without a cast.
 */
export function evalLuauReturnLiterals(root: AstStatBlock): LuauLiteral {
	// The `isAstStatBlock` guard only checks the root tag, so an AST parsed from
	// JSON can reach here without the statements array the type promises.
	const statements: Array<AstStat> | undefined = root.statements;
	if (!Array.isArray(statements)) {
		throw new Error("Config file has no return statement");
	}

	const returnStat = statements.find(
		(stat: unknown) => isAstNode(stat) && readMember(stat, "tag") === "return",
	);

	const expressions = isAstNode(returnStat) ? readMember(returnStat, "expressions") : undefined;
	if (!Array.isArray(expressions)) {
		throw new Error("Config file has no return statement");
	}

	const first: unknown = expressions[0];
	if (!isAstNode(first) || !("node" in first)) {
		throw new Error("Return statement has no expressions");
	}

	return evalExpr(readMember(first, "node"));
}

/**
 * Type predicate for narrowing `JSON.parse` output to `AstStatBlock`. The
 * predicate exempts the call from `halcyon/no-json-value-erasure` and brands
 * the validated value at the type level — production callers don't need a
 * runtime arktype schema or a manual cast to bridge JSON to AST types.
 */
export function isAstStatBlock(value: unknown): value is AstStatBlock {
	return isAstNode(value) && value["tag"] === "block";
}

function isAstNode(value: unknown): value is AstNode {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readMember(value: AstNode, key: string): AstMember {
	return value[key];
}

function evalScalar(current: AstNode, tag: unknown): boolean | number | string | undefined {
	if (tag === "boolean") {
		const value = readMember(current, "value");
		return typeof value === "boolean" ? value : undefined;
	}

	if (tag === "number") {
		const value = readMember(current, "value");
		return typeof value === "number" ? value : undefined;
	}

	if (tag === "string") {
		const text = readMember(current, "text");
		return typeof text === "string" ? text : undefined;
	}

	return undefined;
}

function evalExpr(node: unknown): LuauLiteral {
	if (!isAstNode(node)) {
		return undefined;
	}

	let current = node;

	while (readMember(current, "tag") === "cast") {
		const operand = readMember(current, "operand");
		if (!isAstNode(operand)) {
			break;
		}

		current = operand;
	}

	const tag = readMember(current, "tag");
	const scalar = evalScalar(current, tag);
	if (scalar !== undefined) {
		return scalar;
	}

	const entries = readMember(current, "entries");
	return tag === "table" && Array.isArray(entries) ? evalTable(entries) : undefined;
}

function evalTable(entries: Array<unknown>): LuauLiteral {
	if (entries.length === 0) {
		return {};
	}

	const first = entries[0];
	if (isAstNode(first) && readMember(first, "kind") === "list") {
		return entries.map((entry) => {
			return isAstNode(entry) ? evalExpr(readMember(entry, "value")) : undefined;
		});
	}

	const result: LuauLiteralTable = {};
	for (const entry of entries) {
		if (!isAstNode(entry) || readMember(entry, "kind") !== "record") {
			continue;
		}

		const key = readMember(entry, "key");
		const value = readMember(entry, "value");
		const text = isAstNode(key) ? readMember(key, "text") : undefined;
		if (typeof text === "string") {
			result[text] = evalExpr(value);
		}
	}

	return result;
}
