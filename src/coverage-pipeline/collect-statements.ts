import type { AstStatBlock } from "@isentinel/luau-ast";

import type { LuauVisitor } from "../luau/visitor.ts";
import type { CoverageAccumulator } from "./coverage-accumulator.ts";

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

export function createStatementCollector(accumulator: CoverageAccumulator): Partial<LuauVisitor> {
	return {
		visitStatBlock(block: AstStatBlock): boolean {
			for (const stmt of block.statements) {
				if (!INSTRUMENTABLE_STATEMENT_TAGS.has(stmt.tag)) {
					continue;
				}

				accumulator.addStatement(stmt.location);
			}

			return true;
		},
	};
}
