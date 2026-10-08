/* eslint-disable max-lines -- The official AST shape is inherently verbose. */
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
	/** 1-based UTF-8 byte column where the span begins. */
	beginColumn: number;
	/** 1-based line where the span begins. */
	beginLine: number;
	/** Exclusive 1-based UTF-8 byte column where the span ends. */
	endColumn: number;
	/** 1-based line where the span ends. */
	endLine: number;
}

/** A boolean literal expression. */
export interface AstExprConstantBool {
	/** Source span with 1-based lines and UTF-8 byte columns. */
	location: LuauSpan;
	/** Node kind used to discriminate the tree union. */
	type: "AstExprConstantBool";
	/** Boolean value of the literal. */
	value: boolean;
}

/** The nil literal expression. */
export interface AstExprConstantNil {
	/** Source span with 1-based lines and UTF-8 byte columns. */
	location: LuauSpan;
	/** Node kind used to discriminate the tree union. */
	type: "AstExprConstantNil";
}

/** A numeric literal expression. */
export interface AstExprConstantNumber {
	/** Source span with 1-based lines and UTF-8 byte columns. */
	location: LuauSpan;
	/** Node kind used to discriminate the tree union. */
	type: "AstExprConstantNumber";
	/** Numeric value of the literal. */
	value: number;
}

/** A decoded string literal expression. */
export interface AstExprConstantString {
	/** Source span with 1-based lines and UTF-8 byte columns. */
	location: LuauSpan;
	/** Node kind used to discriminate the tree union. */
	type: "AstExprConstantString";
	/** Decoded contents of the string literal. */
	value: string;
}

/** A reference to a global name. */
export interface AstExprGlobal {
	/** Unresolved global name. */
	global: string;
	/** Source span with 1-based lines and UTF-8 byte columns. */
	location: LuauSpan;
	/** Node kind used to discriminate the tree union. */
	type: "AstExprGlobal";
}

/** A local binding declaration shared by its references. */
export interface AstLocal {
	/** Name introduced by this local declaration. */
	name: string;
	/** Whether the local binding is declared const. */
	isConst: boolean;
	/** Source span with 1-based lines and UTF-8 byte columns. */
	location: LuauSpan;
	/** Opaque type annotation, or null when the local is unannotated. */
	luauType: unknown;
	/** Node kind used to discriminate the tree union. */
	type: "AstLocal";
}

/** A reference to a resolved local binding. */
export interface AstExprLocal {
	/** Local binding referenced by this expression. */
	local: AstLocal;
	/** Source span with 1-based lines and UTF-8 byte columns. */
	location: LuauSpan;
	/** Node kind used to discriminate the tree union. */
	type: "AstExprLocal";
}

/** The variadic argument expression `...`. */
export interface AstExprVarargs {
	/** Source span with 1-based lines and UTF-8 byte columns. */
	location: LuauSpan;
	/** Node kind used to discriminate the tree union. */
	type: "AstExprVarargs";
}

/** Every expression kind emitted by the Luau AST encoder. */
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

/** A break statement exiting the enclosing loop. */
export interface AstStatBreak {
	/** Source span with 1-based lines and UTF-8 byte columns. */
	location: LuauSpan;
	/** Node kind used to discriminate the tree union. */
	type: "AstStatBreak";
}

/** A continue statement advancing the enclosing loop. */
export interface AstStatContinue {
	/** Source span with 1-based lines and UTF-8 byte columns. */
	location: LuauSpan;
	/** Node kind used to discriminate the tree union. */
	type: "AstStatContinue";
}

/** A type alias declaration with opaque annotation nodes. */
export interface AstStatTypeAlias {
	/** Name introduced by the type alias. */
	name: string;
	/** Whether the alias carries the export keyword. */
	exported: boolean;
	/** Opaque generic type-pack parameter declarations. */
	genericPacks: Array<unknown>;
	/** Opaque generic type parameter declarations. */
	generics: Array<unknown>;
	/** Source span with 1-based lines and UTF-8 byte columns. */
	location: LuauSpan;
	/** Node kind used to discriminate the tree union. */
	type: "AstStatTypeAlias";
	/** Opaque type annotation assigned to the alias. */
	value: unknown;
}

/** Every statement kind emitted by the Luau AST encoder. */
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

/** Binary operator names emitted by the Luau AST encoder. */
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

/** Binary operators supported by compound assignment. */
export type CompoundOp = Exclude<
	BinaryOp,
	"And" | "CompareEq" | "CompareGe" | "CompareGt" | "CompareLe" | "CompareLt" | "CompareNe" | "Or"
>;

/** Unary operator names emitted by the Luau AST encoder. */
export type UnaryOp = "Len" | "Minus" | "Not";

/** An expression combining two operands with a binary operator. */
export interface AstExprBinary {
	/** Left operand of the binary expression. */
	left: AstExpr;
	/** Source span with 1-based lines and UTF-8 byte columns. */
	location: LuauSpan;
	/** Operator applied to the operand or operands. */
	op: BinaryOp;
	/** Right operand of the binary expression. */
	right: AstExpr;
	/** Node kind used to discriminate the tree union. */
	type: "AstExprBinary";
}

/** A function or method call expression. */
export interface AstExprCall {
	/** Source span covering the call arguments when recorded. */
	argLocation?: LuauSpan;
	/** Arguments in source order. */
	args: Array<AstExpr>;
	/** Expression producing the function or method being called. */
	func: AstExpr;
	/** Source span with 1-based lines and UTF-8 byte columns. */
	location: LuauSpan;
	/** Whether this call uses method syntax and an implicit self argument. */
	self: boolean;
	/** Node kind used to discriminate the tree union. */
	type: "AstExprCall";
}

/** A function expression with its parameters and body. */
export interface AstExprFunction {
	/** Local parameter bindings in declaration order. */
	args: Array<AstLocal>;
	/** Attributes attached to the declaration. */
	attributes: Array<unknown>;
	/** Function body executed when called. */
	body: AstStatBlock;
	/** Parser-provided name for function diagnostics. */
	debugname: string;
	/** Function nesting depth recorded by the parser. */
	functionDepth: number;
	/** Opaque generic type-pack parameter declarations. */
	genericPacks: Array<unknown>;
	/** Opaque generic type parameter declarations. */
	generics: Array<unknown>;
	/** Source span with 1-based lines and UTF-8 byte columns. */
	location: LuauSpan;
	/** Opaque return type annotation when present. */
	returnAnnotation?: unknown;
	/** Node kind used to discriminate the tree union. */
	type: "AstExprFunction";
	/** Whether the function accepts variadic arguments. */
	vararg: boolean;
	/** Type annotation for the variadic parameter when present. */
	varargAnnotation?: unknown;
	/** Source span recorded for the variadic parameter. */
	varargLocation: LuauSpan;
}

/** A parenthesized expression. */
export interface AstExprGroup {
	/** Expression inside the parentheses. */
	expr: AstExpr;
	/** Source span with 1-based lines and UTF-8 byte columns. */
	location: LuauSpan;
	/** Node kind used to discriminate the tree union. */
	type: "AstExprGroup";
}

/** A conditional expression with true and false branches. */
export interface AstExprIfElse {
	/** Expression selecting a branch or controlling a loop. */
	condition: AstExpr;
	/** Present on `if local` and `if const`; in scope for `trueExpr` only. */
	conditionLocal?: AstLocal;
	/** Expression evaluated when the condition is false. */
	falseExpr: AstExpr;
	/** Whether the parser recorded the else keyword. */
	hasElse: boolean;
	/** Whether the parser recorded the then keyword. */
	hasThen: boolean;
	/** Source span with 1-based lines and UTF-8 byte columns. */
	location: LuauSpan;
	/** Expression evaluated when the condition is true. */
	trueExpr: AstExpr;
	/** Node kind used to discriminate the tree union. */
	type: "AstExprIfElse";
}

/** An expression indexed by another expression. */
export interface AstExprIndexExpr {
	/** Expression producing the indexed value. */
	expr: AstExpr;
	/** Expression producing the index key. */
	index: AstExpr;
	/** Source span with 1-based lines and UTF-8 byte columns. */
	location: LuauSpan;
	/** Node kind used to discriminate the tree union. */
	type: "AstExprIndexExpr";
}

/** A field or method access using a literal name. */
export interface AstExprIndexName {
	/** Expression producing the value whose member is accessed. */
	expr: AstExpr;
	/** Literal field or method name. */
	index: string;
	/** Source span of the accessed field name. */
	indexLocation: LuauSpan;
	/** Source span with 1-based lines and UTF-8 byte columns. */
	location: LuauSpan;
	/** Dot for field access or colon for method access. */
	op: "." | ":";
	/** Node kind used to discriminate the tree union. */
	type: "AstExprIndexName";
}

/** An expression with explicit type arguments. */
export interface AstExprInstantiate {
	/** Expression receiving the explicit type arguments. */
	expr: AstExpr;
	/** Source span with 1-based lines and UTF-8 byte columns. */
	location: LuauSpan;
	/** Node kind used to discriminate the tree union. */
	type: "AstExprInstantiate";
	/** Explicit type arguments supplied to the expression. */
	typeArguments: Array<unknown>;
}

/** An interpolated string with decoded segments and embedded expressions. */
export interface AstExprInterpString {
	/** Embedded expressions in interpolation order. */
	expressions: Array<AstExpr>;
	/** Source span with 1-based lines and UTF-8 byte columns. */
	location: LuauSpan;
	/** Decoded string segments before, between, and after expressions. */
	strings: Array<string>;
	/** Node kind used to discriminate the tree union. */
	type: "AstExprInterpString";
}

/** A table constructor expression. */
export interface AstExprTable {
	/** Entries in source order. */
	items: Array<AstExprTableItem>;
	/** Source span with 1-based lines and UTF-8 byte columns. */
	location: LuauSpan;
	/** Node kind used to discriminate the tree union. */
	type: "AstExprTable";
}

/**
 * `kind: "item"` is a positional entry; `key` is present on the other kinds.
 */
export interface AstExprTableItem {
	/** Key expression, absent for a positional entry. */
	key?: AstExpr;
	/** Entry syntax: positional, named record, or bracketed key. */
	kind: "general" | "item" | "record";
	/** Node kind used to discriminate the tree union. */
	type: "AstExprTableItem";
	/** Expression supplying this entry’s value. */
	value: AstExpr;
}

/** An expression annotated with an asserted type. */
export interface AstExprTypeAssertion {
	/** Opaque asserted type annotation. */
	annotation: unknown;
	/** Expression whose type is asserted. */
	expr: AstExpr;
	/** Source span with 1-based lines and UTF-8 byte columns. */
	location: LuauSpan;
	/** Node kind used to discriminate the tree union. */
	type: "AstExprTypeAssertion";
}

/** An expression applying a unary operator to one operand. */
export interface AstExprUnary {
	/** Operand of the unary operator. */
	expr: AstExpr;
	/** Source span with 1-based lines and UTF-8 byte columns. */
	location: LuauSpan;
	/** Operator applied to the operand or operands. */
	op: UnaryOp;
	/** Node kind used to discriminate the tree union. */
	type: "AstExprUnary";
}

/** An assignment to one or more targets. */
export interface AstStatAssign {
	/** Source span with 1-based lines and UTF-8 byte columns. */
	location: LuauSpan;
	/** Node kind used to discriminate the tree union. */
	type: "AstStatAssign";
	/** Right-hand expressions assigned to the targets in order. */
	values: Array<AstExpr>;
	/** Left-hand assignment targets in source order. */
	vars: Array<AstExpr>;
}

/** A sequence of statements forming a lexical block. */
export interface AstStatBlock {
	/** Statements executed by this block or declaration. */
	body: Array<AstStat>;
	/** Whether the parser recorded the closing end keyword. */
	hasEnd: boolean;
	/** Source span with 1-based lines and UTF-8 byte columns. */
	location: LuauSpan;
	/** Node kind used to discriminate the tree union. */
	type: "AstStatBlock";
}

/** An assignment combining the target with a right-hand operand. */
export interface AstStatCompoundAssign {
	/** Source span with 1-based lines and UTF-8 byte columns. */
	location: LuauSpan;
	/** Operator applied to the operand or operands. */
	op: CompoundOp;
	/** Node kind used to discriminate the tree union. */
	type: "AstStatCompoundAssign";
	/** Right-hand operand combined with the target. */
	value: AstExpr;
	/** Expression receiving the compound assignment. */
	var: AstExpr;
}

/** An expression used as a statement. */
export interface AstStatExpr {
	/** Expression wrapped or evaluated by this node. */
	expr: AstExpr;
	/** Source span with 1-based lines and UTF-8 byte columns. */
	location: LuauSpan;
	/** Node kind used to discriminate the tree union. */
	type: "AstStatExpr";
}

/** A numeric for loop with bounds and an optional step. */
export interface AstStatFor {
	/** Statements executed by this block or declaration. */
	body: AstStatBlock;
	/** Initial value of the numeric loop variable. */
	from: AstExpr;
	/** Whether the parser recorded the do keyword. */
	hasDo: boolean;
	/** Source span with 1-based lines and UTF-8 byte columns. */
	location: LuauSpan;
	/** Loop increment, absent when the default step applies. */
	step?: AstExpr;
	/** Inclusive upper or lower bound of the numeric loop. */
	to: AstExpr;
	/** Node kind used to discriminate the tree union. */
	type: "AstStatFor";
	/** Local binding for the numeric loop variable. */
	var: AstLocal;
}

/** A generic for loop binding values from iterator expressions. */
export interface AstStatForIn {
	/** Statements executed by this block or declaration. */
	body: AstStatBlock;
	/** Whether the parser recorded the do keyword. */
	hasDo: boolean;
	/** Whether the parser recorded the in keyword. */
	hasIn: boolean;
	/** Source span with 1-based lines and UTF-8 byte columns. */
	location: LuauSpan;
	/** Node kind used to discriminate the tree union. */
	type: "AstStatForIn";
	/** Iterator expressions following the in keyword. */
	values: Array<AstExpr>;
	/** Local loop bindings in declaration order. */
	vars: Array<AstLocal>;
}

/** A named function declaration. */
export interface AstStatFunction {
	/** Expression naming the global or member receiving the function. */
	name: AstExpr;
	/** Function definition assigned to the named target. */
	func: AstExprFunction;
	/** Source span with 1-based lines and UTF-8 byte columns. */
	location: LuauSpan;
	/** Node kind used to discriminate the tree union. */
	type: "AstStatFunction";
}

/** A conditional statement with optional alternate branches. */
export interface AstStatIf {
	/** Expression selecting a branch or controlling a loop. */
	condition: AstExpr;
	/** Present on `if local` and `if const`; in scope for `thenbody` only. */
	conditionLocal?: AstLocal;
	/** Alternate block or nested elseif statement when present. */
	elsebody?: AstStatBlock | AstStatIf;
	/** Whether the parser recorded the then keyword. */
	hasThen: boolean;
	/** Source span with 1-based lines and UTF-8 byte columns. */
	location: LuauSpan;
	/** Statements executed when the condition is true. */
	thenbody: AstStatBlock;
	/** Node kind used to discriminate the tree union. */
	type: "AstStatIf";
}

/** A declaration of local bindings and optional initializers. */
export interface AstStatLocal {
	/** Source span with 1-based lines and UTF-8 byte columns. */
	location: LuauSpan;
	/** Node kind used to discriminate the tree union. */
	type: "AstStatLocal";
	/** Initializer expressions, empty for an uninitialized declaration. */
	values: Array<AstExpr>;
	/** Local bindings introduced by the declaration. */
	vars: Array<AstLocal>;
}

/** A function declaration bound to a local name. */
export interface AstStatLocalFunction {
	/** Local binding receiving the function definition. */
	name: AstLocal;
	/** Function definition assigned to the local binding. */
	func: AstExprFunction;
	/** Source span with 1-based lines and UTF-8 byte columns. */
	location: LuauSpan;
	/** Node kind used to discriminate the tree union. */
	type: "AstStatLocalFunction";
}

/** A loop whose condition is evaluated after its body. */
export interface AstStatRepeat {
	/** Statements executed by this block or declaration. */
	body: AstStatBlock;
	/** Expression selecting a branch or controlling a loop. */
	condition: AstExpr;
	/** Source span with 1-based lines and UTF-8 byte columns. */
	location: LuauSpan;
	/** Node kind used to discriminate the tree union. */
	type: "AstStatRepeat";
}

/** A return statement carrying zero or more expressions. */
export interface AstStatReturn {
	/** Returned expressions in source order. */
	list: Array<AstExpr>;
	/** Source span with 1-based lines and UTF-8 byte columns. */
	location: LuauSpan;
	/** Node kind used to discriminate the tree union. */
	type: "AstStatReturn";
}

/** A loop whose condition is evaluated before its body. */
export interface AstStatWhile {
	/** Statements executed by this block or declaration. */
	body: AstStatBlock;
	/** Expression selecting a branch or controlling a loop. */
	condition: AstExpr;
	/** Whether the parser recorded the do keyword. */
	hasDo: boolean;
	/** Source span with 1-based lines and UTF-8 byte columns. */
	location: LuauSpan;
	/** Node kind used to discriminate the tree union. */
	type: "AstStatWhile";
}
