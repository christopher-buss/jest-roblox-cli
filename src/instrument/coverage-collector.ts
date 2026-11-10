import type { ParseSuccess } from "@isentinel/luau-ast";
import type { LuauVisitor } from "@isentinel/luau-ast/visit";
import { visitBlock } from "@isentinel/luau-ast/visit";

import { createBranchCollector } from "./collect-branches.ts";
import { createFunctionCollector } from "./collect-functions.ts";
import { createStatementCollector } from "./collect-statements.ts";
import type { CollectorResult } from "./coverage-accumulator.ts";
import { createCoverageAccumulator } from "./coverage-accumulator.ts";
import { resolveCoverageIgnores } from "./coverage-ignore.ts";
import { toUtf16Columns } from "./utf-16-columns.ts";

/**
 * Collect statement, function and branch coverage records in one AST walk.
 * @param parsed - The AST and comment spans parsed from `source`.
 * @param source - The Luau `parsed` came from, for UTF-16 column conversion.
 * @returns Coverage records with UTF-16 columns.
 */
export function collectCoverage(
	parsed: Pick<ParseSuccess, "comments" | "root">,
	source: string,
): CollectorResult {
	const accumulator = createCoverageAccumulator();
	const ignores = resolveCoverageIgnores(parsed, source);

	visitBlock(parsed.root, {
		...createStatementCollector(accumulator, ignores),
		...createFunctionCollector(accumulator, ignores),
		...createBranchCollector(accumulator, ignores),
	} satisfies LuauVisitor);

	return toUtf16Columns(accumulator.result(), source);
}
