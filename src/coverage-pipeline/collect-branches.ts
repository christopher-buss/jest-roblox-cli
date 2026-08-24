import type {
	AstExprBinary,
	AstExprIfElse,
	AstStatBlock,
	AstStatIf,
} from "@isentinel/luau-ast/ast";
import type { LuauVisitor } from "@isentinel/luau-ast/visit";

import assert from "node:assert";

import { getBodyFirstStatement } from "./collect-functions.ts";
import type { CoverageAccumulator, StatementBranchArm } from "./coverage-accumulator.ts";

/** One statement-if chain flattened: every then-block plus the final else. */
interface StatIfChain {
	blocks: Array<AstStatBlock>;
	elseBlock: AstStatBlock | undefined;
}

export function createBranchCollector(accumulator: CoverageAccumulator): Partial<LuauVisitor> {
	// The parser nests `elseif` chains — the else side of an if node is
	// another if node. Each chain is one multi-arm branch (Istanbul's model),
	// so members folded into their head's arms must not also count alone when
	// the visitor reaches them.
	const chainedExprIfs = new Set<AstExprIfElse>();
	const chainedStatIfs = new Set<AstStatIf>();

	return {
		visitExprBinary: (node) => collectBinaryBranch(node, accumulator),
		visitExprIfElse: (node) => {
			if (!chainedExprIfs.has(node)) {
				collectExprIfBranch(node, { accumulator, chainedExprIfs });
			}

			return true;
		},
		visitStatIf: (node) => {
			if (!chainedStatIfs.has(node)) {
				collectStatIfBranch(node, { accumulator, chainedStatIfs });
			}

			return true;
		},
	};
}

function collectBinaryBranch(node: AstExprBinary, accumulator: CoverageAccumulator): boolean {
	// Only `and`/`or` short-circuit, so only they are branches — every other
	// binary operator (arithmetic, comparison, concat) just keeps traversing
	// into its operands.
	if (node.op !== "And" && node.op !== "Or") {
		return true;
	}

	// Wrap both operands so the value flows through `__cov_br` unchanged
	// while bumping a counter. `and`/`or` short-circuit, so the rhs wrap
	// only runs when the lhs does not short-circuit — the counter
	// records that without altering evaluation. Two arms: lhs, rhs
	// (Istanbul's binary-expr model).
	accumulator.addExpressionBranch("binary-expr", [node.left.location, node.right.location]);

	return true;
}

function collectExprIfBranch(
	node: AstExprIfElse,
	context: { accumulator: CoverageAccumulator; chainedExprIfs: Set<AstExprIfElse> },
): void {
	const armLocations = [node.trueExpr.location];
	let current = node;
	while (current.falseExpr.type === "AstExprIfElse") {
		current = current.falseExpr;
		context.chainedExprIfs.add(current);
		armLocations.push(current.trueExpr.location);
	}

	armLocations.push(current.falseExpr.location);
	context.accumulator.addExpressionBranch("expr-if", armLocations);
}

function flattenStatIfChain(node: AstStatIf, chainedStatIfs: Set<AstStatIf>): StatIfChain {
	const blocks = [node.thenbody];
	let current = node;
	while (current.elsebody?.type === "AstStatIf") {
		current = current.elsebody;
		chainedStatIfs.add(current);
		blocks.push(current.thenbody);
	}

	return { blocks, elseBlock: current.elsebody };
}

function collectStatIfBranch(
	node: AstStatIf,
	context: { accumulator: CoverageAccumulator; chainedStatIfs: Set<AstStatIf> },
): void {
	const { blocks, elseBlock } = flattenStatIfChain(node, context.chainedStatIfs);
	const arms: Array<StatementBranchArm> = blocks.map((block) => {
		return { bodyFirst: getBodyFirstStatement(block), location: block.location };
	});

	// A block with no statements — empty, or holding only comments — is still
	// an `else`. Reading it as absent sends this branch down the synthetic path
	// below, which emits an `else` keyword of its own right before the real one,
	// and Luau rejects the second. `getBodyFirstStatement` falls back to the
	// block's own begin position, just past the `else` keyword, so the arm
	// counter lands inside the block that is already there.
	if (elseBlock !== undefined) {
		arms.push({ bodyFirst: getBodyFirstStatement(elseBlock), location: elseBlock.location });
		context.accumulator.addStatementBranch(arms);

		return;
	}

	// Locate `end` via the last then-block's end position rather than the if
	// statement's own location, which can extend past a trailing `;`.
	const lastBlock = blocks.at(-1);
	assert(lastBlock !== undefined, "a chain always holds its own then-block");
	context.accumulator.addStatementBranch(arms, {
		ifStart: { column: node.location.beginColumn, line: node.location.beginLine },
		probeEnd: { column: lastBlock.location.endColumn, line: lastBlock.location.endLine },
	});
}
