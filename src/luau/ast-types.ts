/**
 * TypeScript types mirroring Lute's @std/syntax AST JSON output.
 * Only the fields needed for coverage instrumentation are included.
 * Token-level fields (trivia, keywords) are omitted.
 */

export interface LuauSpan {
	beginColumn: number;
	beginLine: number;
	endColumn: number;
	endLine: number;
}

export interface Pair<T> {
	node: T;
	separator?: unknown;
}

export type Punctuated<T> = Array<Pair<T>>;

export interface AstLocal {
	name: { text: string };
	kind: "local";
	location: LuauSpan;
}

export interface AstExprGroup extends AstExprBase {
	expression: AstExpr;
	tag: "group";
}

export interface AstExprConstantNil extends AstExprBase {
	tag: "nil";
}

export interface AstExprConstantBool extends AstExprBase {
	tag: "boolean";
	value: boolean;
}

export interface AstExprConstantNumber extends AstExprBase {
	tag: "number";
	value: number;
}

export interface AstExprConstantString extends AstExprBase {
	tag: "string";
	text: string;
}

export interface AstExprLocal extends AstExprBase {
	tag: "local";
	token: unknown;
}

export interface AstExprGlobal extends AstExprBase {
	name: { text: string };
	tag: "global";
}

export interface AstExprVarargs extends AstExprBase {
	tag: "vararg";
}

export interface AstExprCall extends AstExprBase {
	arguments: Punctuated<AstExpr>;
	func: AstExpr;
	tag: "call";
}

export interface AstExprIndexName extends AstExprBase {
	accessor: { text: string };
	expression: AstExpr;
	index: { text: string };
	tag: "indexname";
}

export interface AstExprIndexExpr extends AstExprBase {
	expression: AstExpr;
	index: AstExpr;
	tag: "index";
}

export interface AstExprFunction extends AstExprBase {
	body: AstStatBlock;
	tag: "function";
}

export interface AstExprTable extends AstExprBase {
	entries: Array<AstTableExprItem>;
	tag: "table";
}

export interface AstExprUnary extends AstExprBase {
	operand: AstExpr;
	tag: "unary";
}

export interface AstExprBinary extends AstExprBase {
	lhsOperand: AstExpr;
	rhsOperand: AstExpr;
	tag: "binary";
}

export interface AstExprInterpString extends AstExprBase {
	expressions: Array<AstExpr>;
	tag: "interpolatedstring";
}

export interface AstExprTypeAssertion extends AstExprBase {
	operand: AstExpr;
	tag: "cast";
}

export interface AstElseIfExpr {
	condition: AstExpr;
	thenExpr: AstExpr;
}

export interface AstExprIfElse extends AstExprBase {
	condition: AstExpr;
	elseExpr: AstExpr;
	elseifs: Array<AstElseIfExpr>;
	tag: "conditional";
	thenExpr: AstExpr;
}

export interface AstExprInstantiate extends AstExprBase {
	expr: AstExpr;
	tag: "instantiate";
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
	| AstExprInstantiate
	| AstExprInterpString
	| AstExprLocal
	| AstExprTable
	| AstExprTypeAssertion
	| AstExprUnary
	| AstExprVarargs;

export interface AstTableExprListItem extends AstTableExprItemBase {
	kind: "list";
	value: AstExpr;
}

export interface AstTableExprRecordItem extends AstTableExprItemBase {
	key: { text: string };
	kind: "record";
	value: AstExpr;
}

export interface AstTableExprGeneralItem extends AstTableExprItemBase {
	key: AstExpr;
	kind: "general";
	value: AstExpr;
}

export type AstTableExprItem =
	| AstTableExprGeneralItem
	| AstTableExprListItem
	| AstTableExprRecordItem;

export interface AstStatBlock extends AstStatBase {
	statements: Array<AstStat>;
	tag: "block";
}

export interface AstStatDo extends AstStatBase {
	body: AstStatBlock;
	tag: "do";
}

export interface AstElseIfStat {
	condition: AstExpr;
	thenBlock: AstStatBlock;
}

export interface AstStatIf extends AstStatBase {
	condition: AstExpr;
	elseBlock?: AstStatBlock;
	elseifs: Array<AstElseIfStat>;
	tag: "conditional";
	thenBlock: AstStatBlock;
}

export interface AstStatWhile extends AstStatBase {
	body: AstStatBlock;
	condition: AstExpr;
	tag: "while";
}

export interface AstStatRepeat extends AstStatBase {
	body: AstStatBlock;
	condition: AstExpr;
	tag: "repeat";
}

export interface AstStatFor extends AstStatBase {
	body: AstStatBlock;
	from: AstExpr;
	step?: AstExpr;
	tag: "for";
	to: AstExpr;
}

export interface AstStatForIn extends AstStatBase {
	body: AstStatBlock;
	tag: "forin";
	values: Punctuated<AstExpr>;
}

export interface AstStatBreak extends AstStatBase {
	tag: "break";
}

export interface AstStatContinue extends AstStatBase {
	tag: "continue";
}

export interface AstStatReturn extends AstStatBase {
	expressions: Punctuated<AstExpr>;
	tag: "return";
}

export interface AstStatExpr extends AstStatBase {
	expression: AstExpr;
	tag: "expression";
}

export interface AstStatLocal extends AstStatBase {
	tag: "local";
	values: Punctuated<AstExpr>;
	variables: Punctuated<AstLocal>;
}

export interface AstStatAssign extends AstStatBase {
	tag: "assign";
	values: Punctuated<AstExpr>;
	variables: Punctuated<AstExpr>;
}

export interface AstStatCompoundAssign extends AstStatBase {
	tag: "compoundassign";
	value: AstExpr;
	variable: AstExpr;
}

export interface AstStatFunction extends AstStatBase {
	name: AstExpr;
	func: AstExprFunction;
	tag: "function";
}

export interface AstStatLocalFunction extends AstStatBase {
	name: AstLocal;
	func: AstExprFunction;
	tag: "localfunction";
}

export interface AstStatTypeAlias extends AstStatBase {
	tag: "typealias";
}

export interface AstStatTypeFunction extends AstStatBase {
	tag: "typefunction";
}

export type AstStat =
	| AstStatAssign
	| AstStatBlock
	| AstStatBreak
	| AstStatCompoundAssign
	| AstStatContinue
	| AstStatDo
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
	| AstStatTypeFunction
	| AstStatWhile;

interface AstExprBase {
	kind: "expr";
	location: LuauSpan;
}

interface AstTableExprItemBase {
	separator?: unknown;
}

interface AstStatBase {
	kind: "stat";
	location: LuauSpan;
}
