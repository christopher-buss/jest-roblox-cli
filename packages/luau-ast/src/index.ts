// AST types (official parser shape; see ast.ts)
export type {
	AstExpr,
	AstExprBinary,
	AstExprCall,
	AstExprConstantBool,
	AstExprConstantNil,
	AstExprConstantNumber,
	AstExprConstantString,
	AstExprFunction,
	AstExprGlobal,
	AstExprGroup,
	AstExprIfElse,
	AstExprIndexExpr,
	AstExprIndexName,
	AstExprInterpString,
	AstExprLocal,
	AstExprTable,
	AstExprTableItem,
	AstExprTypeAssertion,
	AstExprUnary,
	AstExprVarargs,
	AstLocal,
	AstStat,
	AstStatAssign,
	AstStatBlock,
	AstStatBreak,
	AstStatCompoundAssign,
	AstStatContinue,
	AstStatExpr,
	AstStatFor,
	AstStatForIn,
	AstStatFunction,
	AstStatIf,
	AstStatLocal,
	AstStatLocalFunction,
	AstStatRepeat,
	AstStatReturn,
	AstStatTypeAlias,
	AstStatWhile,
	BinaryOp,
	CompoundOp,
	LuauSpan,
	UnaryOp,
} from "./ast.ts";

export type { CstFailure, CstParseResult, CstSuccess } from "./cst-materialize.ts";
export { printCst } from "./cst-print.ts";
// Concrete syntax tree (lossless; see ./cst.ts)
export type * from "./cst.ts";
export { CST_NODE_KINDS, forEachCstNode, forEachToken, isCstNode, isToken } from "./cst.ts";

// Lute spawner (for running Luau scripts; parsing is in-process via ./parser.ts)
export type { LuteSpawnOptions } from "./lute-spawner.ts";
export { spawnLute, writeTemporaryLuauScript } from "./lute-spawner.ts";

// Parser
export type {
	CommentSpan,
	CstParseOptions,
	LuauParser,
	ParseFailure,
	ParseResult,
	ParseSuccess,
} from "./parser.ts";
export { loadLuauParser } from "./parser.ts";

// Byte offsets and span math
export type { ByteRange, SourceBytes } from "./source-bytes.ts";
export {
	BYTE_CARRIAGE_RETURN,
	BYTE_LINE_FEED,
	BYTE_SPACE,
	BYTE_TAB,
	indexSourceBytes,
} from "./source-bytes.ts";

// Span identity
export { bindingKey } from "./span-identity.ts";

export type { Utf8OffsetMap } from "./utf8-offsets.ts";
export { createUtf8OffsetMap } from "./utf8-offsets.ts";

// Visitor
export type { LuauVisitor } from "./visit.ts";
export { visitBlock, visitExpression, visitStatement } from "./visit.ts";
