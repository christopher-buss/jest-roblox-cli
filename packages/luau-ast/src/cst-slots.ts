import type { CstNode, CstNodeKind, Punctuated } from "./cst.ts";

/** A node kind's slots: every key but its kind, span, and binding. */
type Slot<Kind extends CstNodeKind> = Exclude<
	keyof Extract<CstNode, { type: Kind }>,
	"binding" | "location" | "type"
>;

type SlotTable = { readonly [Kind in CstNodeKind]: ReadonlyArray<Slot<Kind>> };

/** Each kind lists all its slots; the error names an unlisted one. */
type ListsEverySlot<Table extends SlotTable> = {
	[Kind in CstNodeKind]: [Exclude<Slot<Kind>, Table[Kind][number]>] extends [never]
		? Table[Kind]
		: { unlisted: Exclude<Slot<Kind>, Table[Kind][number]> };
};

function defineSlots<const Table extends SlotTable>(
	table: ListsEverySlot<Table> & Table,
): SlotTable {
	return table;
}

/**
 * Each node kind's slots in lexical order, the order `parse_to_cst_json`
 * (wasm/wrapper.cpp) writes them. Walks follow this table rather than key
 * order, so a node built in code prints right whatever order its keys were
 * written in.
 */
export const CST_SLOTS: SlotTable = defineSlots({
	Assign: ["variables", "equals", "values", "semicolon"],
	Attribute: ["at", "name", "open", "arguments", "close"],
	AttributeList: ["open", "items", "close"],
	Binary: ["left", "operator", "right"],
	Block: ["body"],
	Bool: ["token"],
	Break: ["token", "semicolon"],
	Call: ["callee", "typeArguments", "open", "arguments", "close"],
	CompoundAssign: ["variable", "operator", "value", "semicolon"],
	Continue: ["token", "semicolon"],
	DeclareExternType: [
		"declare",
		"extern",
		"keyword",
		"name",
		"extends",
		"super",
		"with",
		"members",
		"end",
		"semicolon",
	],
	DeclareFunction: [
		"attributes",
		"declare",
		"function",
		"name",
		"generics",
		"open",
		"parameters",
		"vararg",
		"varargColon",
		"varargAnnotation",
		"close",
		"returnColon",
		"returnType",
		"semicolon",
	],
	DeclareGlobal: ["declare", "name", "colon", "annotation", "semicolon"],
	Do: ["do", "body", "end", "semicolon"],
	ElseIf: ["keyword", "condition", "then", "body"],
	ElseIfExpr: ["keyword", "condition", "then", "trueExpr"],
	ExprStat: ["expr", "semicolon"],
	ExternTypeMethod: [
		"attributes",
		"function",
		"name",
		"open",
		"parameters",
		"vararg",
		"varargColon",
		"varargAnnotation",
		"close",
		"returnColon",
		"returnType",
	],
	For: [
		"for",
		"variable",
		"equals",
		"from",
		"fromComma",
		"to",
		"toComma",
		"step",
		"do",
		"body",
		"end",
		"semicolon",
	],
	ForIn: ["for", "variables", "in", "values", "do", "body", "end", "semicolon"],
	FunctionBody: [
		"generics",
		"open",
		"parameters",
		"vararg",
		"varargColon",
		"varargAnnotation",
		"close",
		"returnColon",
		"returnType",
		"block",
		"end",
	],
	FunctionExpr: ["attributes", "keyword", "body"],
	FunctionStat: ["attributes", "keyword", "name", "body", "semicolon"],
	FunctionTypeArgument: ["name", "colon", "annotation"],
	Generics: ["open", "items", "close"],
	GenericType: ["name", "equals", "default"],
	GenericTypePack: ["name", "ellipsis", "equals", "default"],
	Global: ["name"],
	Group: ["open", "expr", "close"],
	If: ["if", "condition", "then", "body", "elseifs", "else", "elseBody", "end", "semicolon"],
	IfElse: ["if", "condition", "then", "trueExpr", "elseifs", "else", "falseExpr"],
	IndexExpr: ["expr", "open", "index", "close"],
	IndexName: ["expr", "operator", "index"],
	Instantiate: ["expr", "typeArguments"],
	InterpString: ["parts"],
	Local: ["export", "keyword", "variables", "equals", "values", "semicolon"],
	LocalDecl: ["name", "colon", "annotation"],
	LocalFunction: ["attributes", "export", "local", "keyword", "name", "body", "semicolon"],
	LocalRef: ["name"],
	Nil: ["token"],
	Number: ["token"],
	Repeat: ["repeat", "body", "until", "condition", "semicolon"],
	Return: ["keyword", "values", "semicolon"],
	Root: ["body", "eof"],
	String: ["token"],
	Table: ["open", "items", "close"],
	TableItem: ["open", "key", "close", "equals", "value", "separator"],
	TypeAlias: ["export", "keyword", "name", "generics", "equals", "value", "semicolon"],
	TypeArguments: ["open1", "open2", "items", "close1", "close2"],
	TypeAssertion: ["expr", "operator", "annotation"],
	TypeFunction: [
		"attributes",
		"generics",
		"open",
		"parameters",
		"tail",
		"close",
		"arrow",
		"returnType",
	],
	TypeFunctionStat: ["export", "keyword", "function", "name", "body", "semicolon"],
	TypeGroup: ["open", "inner", "close"],
	TypeIntersection: ["items"],
	TypeOptional: ["token"],
	TypePackExplicit: ["open", "items", "tail", "close"],
	TypePackGeneric: ["name", "ellipsis"],
	TypePackVariadic: ["ellipsis", "inner"],
	TypeReference: ["prefix", "dot", "name", "open", "arguments", "close"],
	TypeSingletonBool: ["token"],
	TypeSingletonString: ["token"],
	TypeTable: ["open", "items", "close"],
	TypeTableItem: ["access", "open", "key", "name", "close", "colon", "value", "separator"],
	TypeTypeof: ["keyword", "open", "expr", "close"],
	TypeUnion: ["items"],
	Unary: ["operator", "expr"],
	Varargs: ["token"],
	While: ["while", "condition", "do", "body", "end", "semicolon"],
});

type PunctuatedSlot = keyof Punctuated<CstNode>;

const NODE_FIRST: ReadonlyArray<PunctuatedSlot> = ["node", "separator"];
const SEPARATOR_FIRST: ReadonlyArray<PunctuatedSlot> = ["separator", "node"];

/**
 * The slots of a punctuated entry in lexical order. A union or intersection
 * member carries the `|` or `&` before it; every other list's separator
 * follows its entry.
 *
 * @param kind - The kind of the node whose list holds the entry.
 * @returns The entry's slots in order.
 */
export function punctuatedSlots(kind: CstNodeKind | undefined): ReadonlyArray<PunctuatedSlot> {
	return kind === "TypeIntersection" || kind === "TypeUnion" ? SEPARATOR_FIRST : NODE_FIRST;
}
