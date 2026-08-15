import type {
	AstExprBinary,
	AstExprBinaryWithOperator,
	AstExprIfElse,
	AstStatIf,
} from "@isentinel/luau-ast";

import type { LuauVisitor } from "../luau/visitor.ts";
import { getBodyFirstStatement } from "./collect-functions.ts";
import type { CoverageAccumulator, StatementBranchArm } from "./coverage-accumulator.ts";

export function createBranchCollector(accumulator: CoverageAccumulator): Partial<LuauVisitor> {
	return {
		visitExprBinary: (node) => collectBinaryBranch(node, accumulator),
		visitExprIfElse: (node) => collectExprIfBranch(node, accumulator),
		visitStatIf: (node) => collectStatIfBranch(node, accumulator),
	};
}

function collectBinaryBranch(node: AstExprBinary, accumulator: CoverageAccumulator): boolean {
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
	accumulator.addExpressionBranch("binary-expr", [
		node.lhsOperand.location,
		node.rhsOperand.location,
	]);

	return true;
}

function collectExprIfBranch(node: AstExprIfElse, accumulator: CoverageAccumulator): boolean {
	accumulator.addExpressionBranch("expr-if", [
		node.thenExpr.location,
		...node.elseifs.map((elseif) => elseif.thenExpr.location),
		node.elseExpr.location,
	]);

	return true;
}

function collectStatIfBranch(
	{ elseBlock, elseifs, location: ifLocation, thenBlock }: AstStatIf,
	accumulator: CoverageAccumulator,
): boolean {
	const arms: Array<StatementBranchArm> = [
		{ bodyFirst: getBodyFirstStatement(thenBlock), location: thenBlock.location },
		...elseifs.map((elseif) => {
			return {
				bodyFirst: getBodyFirstStatement(elseif.thenBlock),
				location: elseif.thenBlock.location,
			};
		}),
	];

	// A block with no statements — empty, or holding only comments — is still
	// an `else`. Reading it as absent sends this branch down the synthetic path
	// below, which emits an `else` keyword of its own right before the real one,
	// and Luau rejects the second. `getBodyFirstStatement` falls back to the
	// block's own begin position, just past the `else` keyword, so the arm
	// counter lands inside the block that is already there.
	if (elseBlock !== undefined) {
		arms.push({ bodyFirst: getBodyFirstStatement(elseBlock), location: elseBlock.location });
		accumulator.addStatementBranch(arms);

		return true;
	}

	// Locate `end` via the last block's end position. The if statement's own
	// location is unreliable here: Lute extends it past a trailing `;` if
	// present.
	const lastElseif = elseifs.at(-1);
	const lastBlock = lastElseif ? lastElseif.thenBlock : thenBlock;

	accumulator.addStatementBranch(arms, {
		ifStart: { column: ifLocation.beginColumn, line: ifLocation.beginLine },
		probeEnd: { column: lastBlock.location.endColumn, line: lastBlock.location.endLine },
	});

	return true;
}
