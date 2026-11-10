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
import type { CoverageIgnores } from "./coverage-ignore.ts";

interface StatIfChain {
	blocks: Array<AstStatBlock>;
	elseBlock: AstStatBlock | undefined;
}

/**
 * Record each `and`/`or` operand pair, expression-`if` and statement-`if`
 * chain as one branch, skipping ignored spans.
 * @param accumulator - Receives the branch records.
 * @param ignores - Spans excluded from coverage.
 * @returns Visitor hooks that collect branches.
 */
export function createBranchCollector(
	accumulator: CoverageAccumulator,
	ignores: CoverageIgnores,
): Partial<LuauVisitor> {
	const chainedExprIfs = new Set<AstExprIfElse>();
	const chainedStatIfs = new Set<AstStatIf>();

	return {
		visitExprBinary: (node) => {
			if (!ignores.covers(node.location)) {
				collectBinaryBranch(node, accumulator);
			}

			return true;
		},
		visitExprIfElse: (node) => {
			if (!chainedExprIfs.has(node) && !ignores.covers(node.location)) {
				collectExprIfBranch(node, { accumulator, chainedExprIfs });
			}

			return true;
		},
		visitStatIf: (node) => {
			if (!chainedStatIfs.has(node) && !ignores.covers(node.location)) {
				collectStatIfBranch(node, { accumulator, chainedStatIfs, ignores });
			}

			return true;
		},
	};
}

function collectBinaryBranch(node: AstExprBinary, accumulator: CoverageAccumulator): void {
	if (node.op !== "And" && node.op !== "Or") {
		return;
	}

	accumulator.addExpressionBranch("binary-expr", [node.left.location, node.right.location]);
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
	context: {
		accumulator: CoverageAccumulator;
		chainedStatIfs: Set<AstStatIf>;
		ignores: CoverageIgnores;
	},
): void {
	const { blocks, elseBlock } = flattenStatIfChain(node, context.chainedStatIfs);
	const armBlocks = elseBlock === undefined ? blocks : [...blocks, elseBlock];
	const arms: Array<StatementBranchArm> = armBlocks
		.filter((block) => !context.ignores.covers(block.location))
		.map((block) => ({ bodyFirst: getBodyFirstStatement(block), location: block.location }));

	// An empty `else` block still counts: a synthetic `else` beside it breaks.
	if (elseBlock !== undefined || context.ignores.dropsImplicitElse(node)) {
		if (arms.length > 0) {
			context.accumulator.addStatementBranch(arms);
		}

		return;
	}

	// The if statement's own location can extend past a trailing `;`.
	const lastBlock = blocks.at(-1);
	assert(lastBlock !== undefined);
	context.accumulator.addStatementBranch(arms, {
		ifStart: { column: node.location.beginColumn, line: node.location.beginLine },
		probeEnd: { column: lastBlock.location.endColumn, line: lastBlock.location.endLine },
	});
}
