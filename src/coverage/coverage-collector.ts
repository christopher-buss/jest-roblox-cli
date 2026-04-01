import type {
	AstExpr,
	AstExprFunction,
	AstExprIfElse,
	AstStatBlock,
	AstStatFunction,
	AstStatIf,
	AstStatLocalFunction,
	LuauSpan,
} from "../luau/ast-types.ts";
import type { LuauVisitor } from "../luau/visitor.ts";
import { visitBlock } from "../luau/visitor.ts";

const INSTRUMENTABLE_STATEMENT_TAGS: ReadonlySet<string> = new Set([
	"assign",
	"break",
	"compoundassign",
	"conditional",
	"continue",
	"do",
	"expression",
	"for",
	"forin",
	"function",
	"local",
	"localfunction",
	"repeat",
	"return",
	"while",
]);

const END_KEYWORD_LENGTH = 3;

export interface StatementInfo {
	index: number;
	location: LuauSpan;
}

export interface FunctionInfo {
	name: string;
	bodyFirstColumn: number;
	bodyFirstLine: number;
	index: number;
	location: LuauSpan;
}

export interface BranchArmInfo {
	bodyFirstColumn: number;
	bodyFirstLine: number;
	location: LuauSpan;
}

export interface BranchInfo {
	arms: Array<BranchArmInfo>;
	branchType: string;
	index: number;
}

export interface ImplicitElseProbe {
	armIndex: number;
	branchIndex: number;
	endColumn: number;
	endLine: number;
}

export interface ExprIfProbe {
	armIndex: number;
	branchIndex: number;
	exprLocation: LuauSpan;
}

export interface CollectorResult {
	branches: Array<BranchInfo>;
	exprIfProbes: Array<ExprIfProbe>;
	functions: Array<FunctionInfo>;
	implicitElseProbes: Array<ImplicitElseProbe>;
	statements: Array<StatementInfo>;
}

export function collectCoverage(root: AstStatBlock): CollectorResult {
	let statementIndex = 1;
	let functionIndex = 1;
	let branchIndex = 1;

	const statements: Array<StatementInfo> = [];
	const functions: Array<FunctionInfo> = [];
	const branches: Array<BranchInfo> = [];
	const implicitElseProbes: Array<ImplicitElseProbe> = [];
	const exprIfProbes: Array<ExprIfProbe> = [];
	const namedFunctions = new Set<AstExprFunction>();

	const visitor = {
		visitExprFunction(node: AstExprFunction): boolean {
			if (namedFunctions.has(node)) {
				return true;
			}

			const first = getBodyFirstStatement(node.body);
			functions.push({
				name: "(anonymous)",
				bodyFirstColumn: first.column,
				bodyFirstLine: first.line,
				index: functionIndex,
				location: { ...node.location },
			});
			functionIndex++;

			return true;
		},

		visitExprIfElse(node: AstExprIfElse): boolean {
			const branch: BranchInfo = {
				arms: [],
				branchType: "expr-if",
				index: branchIndex,
			};

			let armIndex = 1;

			// then arm
			branch.arms.push({
				bodyFirstColumn: 0,
				bodyFirstLine: 0,
				location: { ...node.thenExpr.location },
			});
			exprIfProbes.push({
				armIndex,
				branchIndex,
				exprLocation: { ...node.thenExpr.location },
			});
			armIndex++;

			// elseif arms
			for (const elseif of node.elseifs) {
				branch.arms.push({
					bodyFirstColumn: 0,
					bodyFirstLine: 0,
					location: { ...elseif.thenExpr.location },
				});
				exprIfProbes.push({
					armIndex,
					branchIndex,
					exprLocation: { ...elseif.thenExpr.location },
				});
				armIndex++;
			}

			// else arm
			branch.arms.push({
				bodyFirstColumn: 0,
				bodyFirstLine: 0,
				location: { ...node.elseExpr.location },
			});
			exprIfProbes.push({
				armIndex,
				branchIndex,
				exprLocation: { ...node.elseExpr.location },
			});

			branches.push(branch);
			branchIndex++;

			return true;
		},

		visitStatBlock(block: AstStatBlock): boolean {
			for (const stmt of block.statements) {
				if (INSTRUMENTABLE_STATEMENT_TAGS.has(stmt.tag)) {
					statements.push({
						index: statementIndex,
						location: { ...stmt.location },
					});
					statementIndex++;
				}
			}

			return true;
		},

		visitStatFunction(node: AstStatFunction): boolean {
			const name = extractFunctionName(node);
			const first = getBodyFirstStatement(node.func.body);
			namedFunctions.add(node.func);
			functions.push({
				name,
				bodyFirstColumn: first.column,
				bodyFirstLine: first.line,
				index: functionIndex,
				location: { ...node.location },
			});
			functionIndex++;

			return true;
		},

		visitStatIf(node: AstStatIf): boolean {
			const branch: BranchInfo = {
				arms: [],
				branchType: "if",
				index: branchIndex,
			};

			// then arm
			const thenFirst = getBodyFirstStatement(node.thenBlock);
			branch.arms.push({
				bodyFirstColumn: thenFirst.column,
				bodyFirstLine: thenFirst.line,
				location: { ...node.thenBlock.location },
			});

			// elseif arms
			for (const elseif of node.elseifs) {
				const elseifFirst = getBodyFirstStatement(elseif.thenBlock);
				branch.arms.push({
					bodyFirstColumn: elseifFirst.column,
					bodyFirstLine: elseifFirst.line,
					location: { ...elseif.thenBlock.location },
				});
			}

			// else arm — treat empty `else end` as no else: roblox-ts never emits
			// empty else blocks, and an empty else has no observable behavior to
			// cover
			const { elseBlock } = node;
			const hasExplicitElse = elseBlock !== undefined && elseBlock.statements.length > 0;

			if (hasExplicitElse) {
				const elseFirst = getBodyFirstStatement(elseBlock);
				branch.arms.push({
					bodyFirstColumn: elseFirst.column,
					bodyFirstLine: elseFirst.line,
					location: { ...elseBlock.location },
				});
			}

			if (!hasExplicitElse) {
				// Implicit else — arm location is the if statement location
				// itself
				branch.arms.push({
					bodyFirstColumn: 0,
					bodyFirstLine: 0,
					location: {
						beginColumn: node.location.beginColumn,
						beginLine: node.location.beginLine,
						endColumn: node.location.beginColumn,
						endLine: node.location.beginLine,
					},
				});

				implicitElseProbes.push({
					armIndex: branch.arms.length,
					branchIndex,
					endColumn: node.location.endColumn - END_KEYWORD_LENGTH,
					endLine: node.location.endLine,
				});
			}

			branches.push(branch);
			branchIndex++;

			return true;
		},

		visitStatLocalFunction(node: AstStatLocalFunction): boolean {
			const name = node.name.name.text;
			const first = getBodyFirstStatement(node.func.body);
			namedFunctions.add(node.func);
			functions.push({
				name,
				bodyFirstColumn: first.column,
				bodyFirstLine: first.line,
				index: functionIndex,
				location: { ...node.location },
			});
			functionIndex++;

			return true;
		},
	} satisfies LuauVisitor;

	visitBlock(root, visitor);

	return { branches, exprIfProbes, functions, implicitElseProbes, statements };
}

function getBodyFirstStatement(block: AstStatBlock): { column: number; line: number } {
	const first = block.statements[0];
	if (first !== undefined) {
		return { column: first.location.beginColumn, line: first.location.beginLine };
	}

	// Empty body — use the block's own start position so the probe
	// inserter can place __cov_f / __cov_b inside the empty body.
	return { column: block.location.beginColumn, line: block.location.beginLine };
}

function extractExprName(expr: AstExpr): string {
	if (expr.tag === "global") {
		return expr.name.text;
	}

	if (expr.tag === "indexname") {
		const object = extractExprName(expr.expression);
		const separator = expr.accessor.text;
		return `${object}${separator}${expr.index.text}`;
	}

	return "(anonymous)";
}

function extractFunctionName(node: AstStatFunction): string {
	return extractExprName(node.name);
}
