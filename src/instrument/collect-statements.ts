import type { AstStatBlock } from "@isentinel/luau-ast/ast";
import type { LuauVisitor } from "@isentinel/luau-ast/visit";

import type { CoverageAccumulator } from "./coverage-accumulator.ts";
import type { CoverageIgnores } from "./coverage-ignore.ts";

const INSTRUMENTABLE_STATEMENT_TYPES: ReadonlySet<string> = new Set([
	"AstStatAssign",
	"AstStatBlock",
	"AstStatBreak",
	"AstStatCompoundAssign",
	"AstStatContinue",
	"AstStatExpr",
	"AstStatFor",
	"AstStatForIn",
	"AstStatFunction",
	"AstStatIf",
	"AstStatLocal",
	"AstStatLocalFunction",
	"AstStatRepeat",
	"AstStatReturn",
	"AstStatWhile",
]);

/**
 * Visitor that records each instrumentable statement.
 * @param accumulator - Receives the statement records.
 * @param ignores - Ignore ranges resolved from the source comments.
 * @returns Visitor callbacks for statement blocks.
 */
export function createStatementCollector(
	accumulator: CoverageAccumulator,
	ignores: CoverageIgnores,
): Partial<LuauVisitor> {
	return {
		visitStatBlock(block: AstStatBlock): boolean {
			for (const statement of block.body) {
				if (
					!INSTRUMENTABLE_STATEMENT_TYPES.has(statement.type) ||
					ignores.covers(statement.location)
				) {
					continue;
				}

				accumulator.addStatement(statement.location);
			}

			return true;
		},
	};
}
