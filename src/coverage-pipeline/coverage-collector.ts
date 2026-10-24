import type { ParseSuccess } from "@isentinel/luau-ast";
import type { LuauVisitor } from "@isentinel/luau-ast/visit";
import { visitBlock } from "@isentinel/luau-ast/visit";

import { createBranchCollector } from "./collect-branches.ts";
import { createFunctionCollector } from "./collect-functions.ts";
import { createStatementCollector } from "./collect-statements.ts";
import type { CollectorResult } from "./coverage-accumulator.ts";
import { createCoverageAccumulator } from "./coverage-accumulator.ts";
import { resolveCoverageIgnores } from "./coverage-ignore.ts";
import { toUtf16Columns } from "./utf16-columns.ts";

export type { CollectorResult } from "./coverage-accumulator.ts";

/**
 * @param parsed - The AST and comment spans parsed from `source`.
 * @param source - The Luau `parsed` came from. Required because the parser
 *   reports byte columns and every consumer of the result indexes a JavaScript
 *   string; see {@link toUtf16Columns}. Taking it here rather than leaving the
 *   conversion to each caller keeps the two out of step by construction.
 */
export function collectCoverage(
	parsed: Pick<ParseSuccess, "comments" | "root">,
	source: string,
): CollectorResult {
	const accumulator = createCoverageAccumulator();
	const ignores = resolveCoverageIgnores(parsed, source);

	// The three collectors claim disjoint visitor callbacks, so one merged
	// visitor drives them all in a single walk.
	visitBlock(parsed.root, {
		...createStatementCollector(accumulator, ignores),
		...createFunctionCollector(accumulator, ignores),
		...createBranchCollector(accumulator, ignores),
	} satisfies LuauVisitor);

	return toUtf16Columns(accumulator.result(), source);
}
