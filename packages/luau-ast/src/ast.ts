/**
 * TypeScript types mirroring the official Luau parser's AST JSON, as emitted
 * by wasm/wrapper.cpp (Luau's AstJsonEncoder at the pinned version). Node
 * `type` values are the C++ class names. Type-annotation nodes are typed
 * `unknown` — no consumer traverses them.
 *
 * Optional fields are omitted by the encoder when absent, except `luauType`,
 * which is an explicit `null`.
 *
 * Locations arrive from the encoder as 0-based `"line,col - line,col"`
 * strings; the parser decodes them into {@link LuauSpan} before consumers see
 * a node, converting to this workspace's span convention (1-based, exclusive
 * end, UTF-8 byte columns) so span math matches the Lute-era helpers.
 */

/**
 * Lines and columns are 1-based, and an end is exclusive. A column counts
 * UTF-8 *bytes*, which is Luau's convention across its tooling — convert it
 * before indexing a JavaScript string, whose offsets are UTF-16 code units,
 * or a span on a line holding a multi-byte character will resolve inside that
 * character.
 */
export interface LuauSpan {
	beginColumn: number;
	beginLine: number;
	endColumn: number;
	endLine: number;
}

export interface AstExprConstantBool {
	location: LuauSpan;
	type: "AstExprConstantBool";
	value: boolean;
}

export interface AstExprConstantNil {
	location: LuauSpan;
	type: "AstExprConstantNil";
}

export interface AstExprConstantNumber {
	location: LuauSpan;
	type: "AstExprConstantNumber";
	value: number;
}

export interface AstExprConstantString {
	location: LuauSpan;
	type: "AstExprConstantString";
	value: string;
}

export interface AstExprGlobal {
	global: string;
	location: LuauSpan;
	type: "AstExprGlobal";
}

export interface AstLocal {
	name: string;
	isConst: boolean;
	location: LuauSpan;
	luauType: unknown;
	type: "AstLocal";
}

export interface AstExprLocal {
	local: AstLocal;
	location: LuauSpan;
	type: "AstExprLocal";
}

export interface AstExprVarargs {
	location: LuauSpan;
	type: "AstExprVarargs";
}

export type AstExpr =
	| AstExprBinary
	| AstExprCall
	| AstExprConstantBool
	| AstExprConstantNil
	| AstExprConstantNumber
	| AstExprConstantString
	| AstExprFunction
	| AstExprGlobal
	| AstExprGroup
	| AstExprIfElse
	| AstExprIndexExpr
	| AstExprIndexName
	| AstExprInterpString
	| AstExprLocal
	| AstExprTable
	| AstExprTypeAssertion
	| AstExprUnary
	| AstExprVarargs;

export interface AstStatBreak {
	location: LuauSpan;
	type: "AstStatBreak";
}

export interface AstStatContinue {
	location: LuauSpan;
	type: "AstStatContinue";
}

export interface AstStatTypeAlias {
	name: string;
	exported: boolean;
	genericPacks: Array<unknown>;
	generics: Array<unknown>;
	location: LuauSpan;
	type: "AstStatTypeAlias";
	value: unknown;
}

export type AstStat =
	| AstStatAssign
	| AstStatBlock
	| AstStatBreak
	| AstStatCompoundAssign
	| AstStatContinue
	| AstStatExpr
	| AstStatFor
	| AstStatForIn
	| AstStatFunction
	| AstStatIf
	| AstStatLocal
	| AstStatLocalFunction
	| AstStatRepeat
	| AstStatReturn
	| AstStatTypeAlias
	| AstStatWhile;

export type BinaryOp =
	| "Add"
	| "And"
	| "CompareEq"
	| "CompareGe"
	| "CompareGt"
	| "CompareLe"
	| "CompareLt"
	| "CompareNe"
	| "Concat"
	| "Div"
	| "FloorDiv"
	| "Mod"
	| "Mul"
	| "Or"
	| "Pow"
	| "Sub";

export type CompoundOp = Exclude<
	BinaryOp,
	"And" | "CompareEq" | "CompareGe" | "CompareGt" | "CompareLe" | "CompareLt" | "CompareNe" | "Or"
>;

export type UnaryOp = "Len" | "Minus" | "Not";

export interface AstExprBinary {
	left: AstExpr;
	location: LuauSpan;
	op: BinaryOp;
	right: AstExpr;
	type: "AstExprBinary";
}

export interface AstExprCall {
	argLocation?: LuauSpan;
	args: Array<AstExpr>;
	func: AstExpr;
	location: LuauSpan;
	self: boolean;
	type: "AstExprCall";
}

export interface AstExprFunction {
	args: Array<AstLocal>;
	attributes: Array<unknown>;
	body: AstStatBlock;
	debugname: string;
	functionDepth: number;
	genericPacks: Array<unknown>;
	generics: Array<unknown>;
	location: LuauSpan;
	returnAnnotation?: unknown;
	type: "AstExprFunction";
	vararg: boolean;
	varargAnnotation?: unknown;
	varargLocation: LuauSpan;
}

export interface AstExprGroup {
	expr: AstExpr;
	location: LuauSpan;
	type: "AstExprGroup";
}

export interface AstExprIfElse {
	condition: AstExpr;
	falseExpr: AstExpr;
	hasElse: boolean;
	hasThen: boolean;
	location: LuauSpan;
	trueExpr: AstExpr;
	type: "AstExprIfElse";
}

export interface AstExprIndexExpr {
	expr: AstExpr;
	index: AstExpr;
	location: LuauSpan;
	type: "AstExprIndexExpr";
}

export interface AstExprIndexName {
	expr: AstExpr;
	index: string;
	indexLocation: LuauSpan;
	location: LuauSpan;
	op: "." | ":";
	type: "AstExprIndexName";
}

export interface AstExprInterpString {
	expressions: Array<AstExpr>;
	location: LuauSpan;
	strings: Array<string>;
	type: "AstExprInterpString";
}

export interface AstExprTable {
	items: Array<AstExprTableItem>;
	location: LuauSpan;
	type: "AstExprTable";
}

/**
 * `kind: "item"` is a positional entry; `key` is present on the other kinds.
 */
export interface AstExprTableItem {
	key?: AstExpr;
	kind: "general" | "item" | "record";
	type: "AstExprTableItem";
	value: AstExpr;
}

export interface AstExprTypeAssertion {
	annotation: unknown;
	expr: AstExpr;
	location: LuauSpan;
	type: "AstExprTypeAssertion";
}

export interface AstExprUnary {
	expr: AstExpr;
	location: LuauSpan;
	op: UnaryOp;
	type: "AstExprUnary";
}

export interface AstStatAssign {
	location: LuauSpan;
	type: "AstStatAssign";
	values: Array<AstExpr>;
	vars: Array<AstExpr>;
}

export interface AstStatBlock {
	body: Array<AstStat>;
	hasEnd: boolean;
	location: LuauSpan;
	type: "AstStatBlock";
}

export interface AstStatCompoundAssign {
	location: LuauSpan;
	op: CompoundOp;
	type: "AstStatCompoundAssign";
	value: AstExpr;
	var: AstExpr;
}

export interface AstStatExpr {
	expr: AstExpr;
	location: LuauSpan;
	type: "AstStatExpr";
}

export interface AstStatFor {
	body: AstStatBlock;
	from: AstExpr;
	hasDo: boolean;
	location: LuauSpan;
	step?: AstExpr;
	to: AstExpr;
	type: "AstStatFor";
	var: AstLocal;
}

export interface AstStatForIn {
	body: AstStatBlock;
	hasDo: boolean;
	hasIn: boolean;
	location: LuauSpan;
	type: "AstStatForIn";
	values: Array<AstExpr>;
	vars: Array<AstLocal>;
}

export interface AstStatFunction {
	name: AstExpr;
	func: AstExprFunction;
	location: LuauSpan;
	type: "AstStatFunction";
}

export interface AstStatIf {
	condition: AstExpr;
	elsebody?: AstStatBlock | AstStatIf;
	hasThen: boolean;
	location: LuauSpan;
	thenbody: AstStatBlock;
	type: "AstStatIf";
}

export interface AstStatLocal {
	location: LuauSpan;
	type: "AstStatLocal";
	values: Array<AstExpr>;
	vars: Array<AstLocal>;
}

export interface AstStatLocalFunction {
	name: AstLocal;
	func: AstExprFunction;
	location: LuauSpan;
	type: "AstStatLocalFunction";
}

export interface AstStatRepeat {
	body: AstStatBlock;
	condition: AstExpr;
	location: LuauSpan;
	type: "AstStatRepeat";
}

export interface AstStatReturn {
	list: Array<AstExpr>;
	location: LuauSpan;
	type: "AstStatReturn";
}

export interface AstStatWhile {
	body: AstStatBlock;
	condition: AstExpr;
	hasDo: boolean;
	location: LuauSpan;
	type: "AstStatWhile";
}
