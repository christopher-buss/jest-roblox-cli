import type {
	AstExpr,
	AstExprBinary,
	AstExprBinaryWithOperator,
	AstExprFunction,
	AstExprIfElse,
	AstStatBlock,
	AstStatFunction,
	AstStatIf,
	AstStatLocalFunction,
	LuauSpan,
} from "@isentinel/luau-ast";

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

export interface CollectorResult {
	branches: Array<BranchInfo>;
	functions: Array<FunctionInfo>;
	implicitElseProbes: Array<ImplicitElseProbe>;
	statements: Array<StatementInfo>;
	wrapProbes: Array<WrapProbe>;
}

interface StatementInfo {
	index: number;
	location: LuauSpan;
}

interface FunctionInfo {
	name: string;
	bodyFirstColumn: number;
	bodyFirstLine: number;
	index: number;
	location: LuauSpan;
}

/**
 * One arm of a branch.
 *
 * `bodyFirstLine: 0` / `bodyFirstColumn: 0` is a sentinel meaning the arm is
 * covered by a wrap probe (`__cov_br`, see {@link WrapProbe}) rather than a
 * statement point probe (`__cov_b[n][m] += 1`). `probe-inserter.ts` skips point
 * probes for any arm with `bodyFirstLine === 0`. Both `binary-expr` (`and`/`or`)
 * and `expr-if` arms use this convention; statement-`if` arms carry real body
 * positions.
 */
interface BranchArmInfo {
	bodyFirstColumn: number;
	bodyFirstLine: number;
	location: LuauSpan;
}

interface BranchInfo {
	arms: Array<BranchArmInfo>;
	branchType: string;
	index: number;
}

interface ImplicitElseProbe {
	armIndex: number;
	branchIndex: number;
	endColumn: number;
	endLine: number;
}

/**
 * An operand expression to wrap with the `__cov_br` runtime helper. Shared by
 * expression-`if` arms and `and`/`or` operands — both are instrumented by
 * wrapping the original expression so its value flows through unchanged while a
 * branch counter is bumped, preserving short-circuit semantics.
 */
interface WrapProbe {
	armIndex: number;
	branchIndex: number;
	exprLocation: LuauSpan;
}

export function collectCoverage(root: AstStatBlock): CollectorResult {
	let statementIndex = 1;
	let functionIndex = 1;
	let branchIndex = 1;

	const statements: Array<StatementInfo> = [];
	const functions: Array<FunctionInfo> = [];
	const branches: Array<BranchInfo> = [];
	const implicitElseProbes: Array<ImplicitElseProbe> = [];
	const wrapProbes: Array<WrapProbe> = [];
	const namedFunctions = new Set<AstExprFunction>();

	const visitor = {
		visitExprBinary(node: AstExprBinary): boolean {
			// Lute's binary node carries an operator token; coverage's
			// parse-ast keeps only its text. Only `and`/`or` short-circuit, so
			// only they are branches — every other binary operator (arithmetic,
			// comparison, concat) just keeps traversing into its operands.
			//
			// `AstExprBinary` has no `operator` field — `parse-ast.luau`
			// populates it at runtime via its `KEEP["binary"]` allowlist — so
			// probe for it through `Partial`. `AstExprBinaryWithOperator` was
			// introduced for mutation testing, but its operator text is exactly
			// what coverage needs; the reuse is intentional.
			const withOperator = node as Partial<AstExprBinaryWithOperator>;
			const operator = withOperator.operator?.text;
			if (operator !== "and" && operator !== "or") {
				return true;
			}

			// Wrap both operands so the value flows through `__cov_br` unchanged
			// while bumping a counter. `and`/`or` short-circuit, so the rhs wrap
			// only runs when the lhs does not short-circuit — the counter
			// records that without altering evaluation. Two arms: lhs, rhs
			// (Istanbul's binary-expr model).
			branches.push({
				arms: [
					{
						bodyFirstColumn: 0,
						bodyFirstLine: 0,
						location: { ...node.lhsOperand.location },
					},
					{
						bodyFirstColumn: 0,
						bodyFirstLine: 0,
						location: { ...node.rhsOperand.location },
					},
				],
				branchType: "binary-expr",
				index: branchIndex,
			});
			wrapProbes.push(
				{ armIndex: 1, branchIndex, exprLocation: { ...node.lhsOperand.location } },
				{ armIndex: 2, branchIndex, exprLocation: { ...node.rhsOperand.location } },
			);
			branchIndex++;

			return true;
		},

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
			wrapProbes.push({
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
				wrapProbes.push({
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
			wrapProbes.push({
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
				if (!INSTRUMENTABLE_STATEMENT_TAGS.has(stmt.tag)) {
					continue;
				}

				statements.push({
					index: statementIndex,
					location: { ...stmt.location },
				});
				statementIndex++;
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
			const { elseBlock, elseifs, location: ifLocation, thenBlock } = node;

			const branch: BranchInfo = {
				arms: [],
				branchType: "if",
				index: branchIndex,
			};

			// then arm
			const thenFirst = getBodyFirstStatement(thenBlock);
			branch.arms.push({
				bodyFirstColumn: thenFirst.column,
				bodyFirstLine: thenFirst.line,
				location: { ...thenBlock.location },
			});

			// elseif arms
			for (const elseif of elseifs) {
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
			const hasExplicitElse = elseBlock !== undefined && elseBlock.statements.length > 0;

			if (hasExplicitElse) {
				const elseFirst = getBodyFirstStatement(elseBlock);
				branch.arms.push({
					bodyFirstColumn: elseFirst.column,
					bodyFirstLine: elseFirst.line,
					location: { ...elseBlock.location },
				});
			} else {
				// Implicit else — arm location is the if statement location
				// itself
				branch.arms.push({
					bodyFirstColumn: 0,
					bodyFirstLine: 0,
					location: {
						beginColumn: ifLocation.beginColumn,
						beginLine: ifLocation.beginLine,
						endColumn: ifLocation.beginColumn,
						endLine: ifLocation.beginLine,
					},
				});

				// Locate `end` via the last block's end position. The if
				// statement's own location is unreliable here: Lute extends it
				// past a trailing `;` if present.
				const lastElseif = elseifs.at(-1);
				const lastBlock = lastElseif ? lastElseif.thenBlock : thenBlock;

				implicitElseProbes.push({
					armIndex: branch.arms.length,
					branchIndex,
					endColumn: lastBlock.location.endColumn,
					endLine: lastBlock.location.endLine,
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

	return { branches, functions, implicitElseProbes, statements, wrapProbes };
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
