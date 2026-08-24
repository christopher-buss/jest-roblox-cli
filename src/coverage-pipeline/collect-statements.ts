import type { AstStatBlock } from "@isentinel/luau-ast/ast";
import type { LuauVisitor } from "@isentinel/luau-ast/visit";

import type { CoverageAccumulator } from "./coverage-accumulator.ts";

// A nested AstStatBlock in a body list is a `do ... end` statement — block
// nodes reached through if/while/for/function fields never appear here.
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

export function createStatementCollector(accumulator: CoverageAccumulator): Partial<LuauVisitor> {
	return {
		visitStatBlock(block: AstStatBlock): boolean {
			for (const statement of block.body) {
				if (!INSTRUMENTABLE_STATEMENT_TYPES.has(statement.type)) {
					continue;
				}

				accumulator.addStatement(statement.location);
			}

			return true;
		},
	};
}
