import type { AstStatBlock } from "@isentinel/luau-ast";

import type { LuauVisitor } from "../luau/visitor.ts";
import { visitBlock } from "../luau/visitor.ts";
import { createBranchCollector } from "./collect-branches.ts";
import { createFunctionCollector } from "./collect-functions.ts";
import { createStatementCollector } from "./collect-statements.ts";
import type { CollectorResult } from "./coverage-accumulator.ts";
import { createCoverageAccumulator } from "./coverage-accumulator.ts";
import { toUtf16Columns } from "./utf16-columns.ts";

export type { CollectorResult } from "./coverage-accumulator.ts";

/**
 * @param root - The AST lute parsed from `source`.
 * @param source - The Luau `root` was parsed from. Required because lute
 *   reports byte columns and every consumer of the result indexes a JavaScript
 *   string; see {@link toUtf16Columns}. Taking it here rather than leaving the
 *   conversion to each caller keeps the two out of step by construction.
 */
export function collectCoverage(root: AstStatBlock, source: string): CollectorResult {
	const accumulator = createCoverageAccumulator();

	// The three collectors claim disjoint visitor callbacks, so one merged
	// visitor drives them all in a single walk.
	visitBlock(root, {
		...createStatementCollector(accumulator),
		...createFunctionCollector(accumulator),
		...createBranchCollector(accumulator),
	} satisfies LuauVisitor);

	return toUtf16Columns(accumulator.result(), source);
}
