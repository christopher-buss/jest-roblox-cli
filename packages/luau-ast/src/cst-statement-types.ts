/**
 * Statement nodes of the concrete syntax tree. Every statement may end in a
 * `semicolon` token.
 */

import type {
	CstExpr,
	CstFunctionBody,
	CstLocalDeclaration,
	CstNodeBase,
	CstSignature,
	CstTokenNode,
	Punctuated,
} from "./cst-expression-types.ts";
import type { Token } from "./cst-token.ts";
import type {
	CstAttributes,
	CstFunctionTypeArgument,
	CstGenerics,
	CstType,
	CstTypeTableItem,
} from "./cst-types.ts";

/**
 * A concrete statement with an optional terminating semicolon.
 * @template Kind - Discriminant identifying this statement.
 */
export interface CstStatBase<Kind extends string> extends CstNodeBase<Kind> {
	/** Optional semicolon terminating the statement. */
	semicolon?: Token;
}

/** Statements in one lexical block, in source order. */
export interface CstBlock extends CstNodeBase<"Block"> {
	/** Statements executed by this block or declaration. */
	body: Array<CstStat>;
}

/** An explicit do block with its closing end token. */
export interface CstDo extends CstStatBase<"Do"> {
	/** Statements executed by this block or declaration. */
	body: CstBlock;
	/** Do keyword introducing the block when recorded. */
	do: Token;
	/** End keyword closing the construct. */
	end: Token;
}

/** An elseif branch with its condition and statements. */
export interface CstElseIf extends CstNodeBase<"ElseIf"> {
	/** Statements executed by this block or declaration. */
	body: CstBlock;
	/** Expression selecting a branch or controlling a loop. */
	condition: CstExpr;
	/** Equals token introducing the assigned value or initializer. */
	equals?: Token;
	/** Keyword introducing this construct. */
	keyword: Token;
	/** Conditional binding visible only in this branch. */
	local?: CstLocalDeclaration;
	/** Local or const keyword introducing a conditional binding. */
	localKeyword?: Token;
	/** Then keyword when recorded by the parser. */
	then?: Token;
}

/** An if statement with elseif and else branches. */
export interface CstIf extends CstStatBase<"If"> {
	/** Statements executed by this block or declaration. */
	body: CstBlock;
	/** Expression selecting a branch or controlling a loop. */
	condition: CstExpr;
	/** Else keyword when the alternate branch is present. */
	else?: Token;
	/** Statements of the else branch when present. */
	elseBody?: CstBlock;
	/** Elseif branches in source order. */
	elseifs: Array<CstElseIf>;
	/** End keyword closing the construct. */
	end: Token;
	/** Equals token introducing the assigned value or initializer. */
	equals?: Token;
	/** If keyword introducing the first branch. */
	if: Token;
	/** Conditional binding visible only in the first branch. */
	local?: CstLocalDeclaration;
	/** Local or const keyword introducing a conditional binding. */
	localKeyword?: Token;
	/** Then keyword when recorded by the parser. */
	then?: Token;
}

/** A while loop retaining its condition and delimiters. */
export interface CstWhile extends CstStatBase<"While"> {
	/** Statements executed by this block or declaration. */
	body: CstBlock;
	/** Expression selecting a branch or controlling a loop. */
	condition: CstExpr;
	/** Do keyword introducing the block when recorded. */
	do?: Token;
	/** End keyword closing the construct. */
	end: Token;
	/** While keyword introducing the loop. */
	while: Token;
}

/** A repeat loop retaining its trailing until condition. */
export interface CstRepeat extends CstStatBase<"Repeat"> {
	/** Statements executed by this block or declaration. */
	body: CstBlock;
	/** Expression selecting a branch or controlling a loop. */
	condition: CstExpr;
	/** Repeat keyword introducing the loop. */
	repeat: Token;
	/** Until keyword introducing the terminating condition. */
	until: Token;
}

/** A break statement and its keyword token. */
export interface CstBreak extends CstStatBase<"Break">, CstTokenNode<"Break"> {}

/** A continue statement and its keyword token. */
export interface CstContinue extends CstStatBase<"Continue">, CstTokenNode<"Continue"> {}

/** A return statement retaining its separated expressions. */
export interface CstReturn extends CstStatBase<"Return"> {
	/** Return keyword introducing the statement. */
	keyword: Token;
	/** Returned expressions paired with their trailing separators. */
	values: Array<Punctuated<CstExpr>>;
}

/** An expression used as a statement. */
export interface CstExprStat extends CstStatBase<"ExprStat"> {
	/** Expression executed as a statement. */
	expr: CstExpr;
}

/** `keyword` is `local` or `const`. */
export interface CstLocal extends CstStatBase<"Local"> {
	/** Equals token introducing the assigned value or initializer. */
	equals?: Token;
	/** Export keyword when the declaration is exported. */
	export?: Token;
	/** Local or const keyword introducing the bindings. */
	keyword: Token;
	/** Initializer expressions, empty for an uninitialized declaration. */
	values: Array<Punctuated<CstExpr>>;
	/** Local declarations paired with their trailing separators. */
	variables: Array<Punctuated<CstLocalDeclaration>>;
}

/** A numeric for loop retaining its bounds and separators. */
export interface CstFor extends CstStatBase<"For"> {
	/** Statements executed by this block or declaration. */
	body: CstBlock;
	/** Do keyword introducing the block when recorded. */
	do?: Token;
	/** End keyword closing the construct. */
	end: Token;
	/** Equals token introducing the assigned value or initializer. */
	equals: Token;
	/** For keyword introducing the loop. */
	for: Token;
	/** Initial value of the numeric loop variable. */
	from: CstExpr;
	/** Comma separating the initial value from the bound. */
	fromComma: Token;
	/** Loop increment, absent when the default step applies. */
	step?: CstExpr;
	/** Inclusive upper or lower bound of the numeric loop. */
	to: CstExpr;
	/** Comma preceding the explicit loop step when present. */
	toComma?: Token;
	/** Local binding for the numeric loop variable. */
	variable: CstLocalDeclaration;
}

/** A generic for loop retaining bindings and iterator expressions. */
export interface CstForIn extends CstStatBase<"ForIn"> {
	/** Statements executed by this block or declaration. */
	body: CstBlock;
	/** Do keyword introducing the block when recorded. */
	do?: Token;
	/** End keyword closing the construct. */
	end: Token;
	/** For keyword introducing the loop. */
	for: Token;
	/** In keyword preceding the iterator expressions when recorded. */
	in?: Token;
	/** Iterator expressions paired with their trailing separators. */
	values: Array<Punctuated<CstExpr>>;
	/** Loop bindings paired with their trailing separators. */
	variables: Array<Punctuated<CstLocalDeclaration>>;
}

/** An assignment retaining its separated targets and values. */
export interface CstAssign extends CstStatBase<"Assign"> {
	/** Equals token introducing the assigned value or initializer. */
	equals: Token;
	/** Right-hand expressions paired with their trailing separators. */
	values: Array<Punctuated<CstExpr>>;
	/** Assignment targets paired with their trailing separators. */
	variables: Array<Punctuated<CstExpr>>;
}

/** A compound assignment retaining its operator token. */
export interface CstCompoundAssign extends CstStatBase<"CompoundAssign"> {
	/** Operator token connecting this node to its operand or target. */
	operator: Token;
	/** Right-hand operand combined with the target. */
	value: CstExpr;
	/** Expression receiving the compound assignment. */
	variable: CstExpr;
}

/** A named function declaration retaining its name expression. */
export interface CstFunctionStat extends CstStatBase<"FunctionStat"> {
	/** Expression naming the global or member receiving the function. */
	name: CstExpr;
	/** Attributes attached to the declaration. */
	attributes?: CstAttributes;
	/** Function signature and body following the name. */
	body: CstFunctionBody;
	/** Function keyword introducing the declaration. */
	keyword: Token;
}

/**
 * `local` is `local` or `const`; `export function f` carries `export` instead.
 */
export interface CstLocalFunction extends CstStatBase<"LocalFunction"> {
	/** Local declaration receiving the function definition. */
	name: CstLocalDeclaration;
	/** Attributes attached to the declaration. */
	attributes?: CstAttributes;
	/** Function signature and body following the name. */
	body: CstFunctionBody;
	/** Export keyword when the declaration is exported. */
	export?: Token;
	/** Function keyword following the local, const, or export keyword. */
	keyword: Token;
	/** Local or const keyword, absent on exported function declarations. */
	local?: Token;
}

/** A type alias declaration retaining its annotation syntax. */
export interface CstTypeAlias extends CstStatBase<"TypeAlias"> {
	/** Name token introduced by the type alias. */
	name: Token;
	/** Equals token introducing the assigned value or initializer. */
	equals: Token;
	/** Export keyword when the declaration is exported. */
	export?: Token;
	/** Generic type parameters attached to the declaration. */
	generics?: CstGenerics;
	/** Type keyword introducing the alias. */
	keyword: Token;
	/** Type annotation assigned to the alias. */
	value: CstType;
}

/** A type function declaration: `type function Name(...) ... End`. */
export interface CstTypeFunctionStat extends CstStatBase<"TypeFunctionStat"> {
	/** Name token introduced by the type function. */
	name: Token;
	/** Type function signature and executable body. */
	body: CstFunctionBody;
	/** Export keyword when the declaration is exported. */
	export?: Token;
	/** Function keyword introducing the declaration. */
	function: Token;
	/** Type keyword preceding the function keyword. */
	keyword: Token;
}

/** An ambient global declaration: `declare name: T`. */
export interface CstDeclareGlobal extends CstStatBase<"DeclareGlobal"> {
	/** Name token introduced by the ambient global declaration. */
	name: Token;
	/** Type annotation attached to the expression or declaration. */
	annotation: CstType;
	/** Colon introducing the type annotation. */
	colon: Token;
	/** Declare keyword introducing the ambient declaration. */
	declare: Token;
}

/** An ambient function declaration and its typed signature. */
export interface CstDeclareFunction
	extends CstSignature<CstFunctionTypeArgument>, CstStatBase<"DeclareFunction"> {
	/** Name token introduced by the ambient function declaration. */
	name: Token;
	/** Attributes attached to the declaration. */
	attributes?: CstAttributes;
	/** Declare keyword introducing the ambient declaration. */
	declare: Token;
	/** Function keyword introducing the declaration. */
	function: Token;
	/** Generic type parameters attached to the declaration. */
	generics?: CstGenerics;
}

/** A method's `self` is its first parameter. */
export interface CstExternTypeMethod
	extends CstNodeBase<"ExternTypeMethod">, CstSignature<CstFunctionTypeArgument> {
	/** Method name token in the extern type body. */
	name: Token;
	/** Attributes attached to the declaration. */
	attributes?: CstAttributes;
	/** Function keyword introducing the declaration. */
	function: Token;
}

/** An extern type: `declare extern type Name [extends Super] with ... End`. */
export interface CstDeclareExternType extends CstStatBase<"DeclareExternType"> {
	/** Name token introduced by the extern type declaration. */
	name: Token;
	/** Declare keyword introducing the ambient declaration. */
	declare: Token;
	/** End keyword closing the construct. */
	end: Token;
	/** Extends keyword when a superclass is declared. */
	extends?: Token;
	/** Extern keyword marking the type declaration. */
	extern: Token;
	/** Type keyword introducing the extern type name. */
	keyword: Token;
	/** Properties and methods in declaration order. */
	members: Array<CstExternTypeMethod | CstTypeTableItem>;
	/** Name token of the extended extern type. */
	super?: Token;
	/** With keyword introducing the extern type members. */
	with: Token;
}

/** Every statement kind in the concrete syntax tree. */
export type CstStat =
	| CstAssign
	| CstBreak
	| CstCompoundAssign
	| CstContinue
	| CstDeclareExternType
	| CstDeclareFunction
	| CstDeclareGlobal
	| CstDo
	| CstExprStat
	| CstFor
	| CstForIn
	| CstFunctionStat
	| CstIf
	| CstLocal
	| CstLocalFunction
	| CstRepeat
	| CstReturn
	| CstTypeAlias
	| CstTypeFunctionStat
	| CstWhile;

/**
 * `eof` is an empty token at the end of the source; its leading trivia is
 * the file's tail.
 */
export interface CstRoot extends CstNodeBase<"Root"> {
	/** Statements executed by this block or declaration. */
	body: CstBlock;
	/** Empty final token carrying the remaining file trivia. */
	eof: Token;
}
