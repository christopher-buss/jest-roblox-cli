import type { AstStatBlock } from "@isentinel/luau-ast";

import type { LuauVisitor } from "../luau/visitor.ts";
import { visitBlock } from "../luau/visitor.ts";
import { createBranchCollector } from "./collect-branches.ts";
import { createFunctionCollector } from "./collect-functions.ts";
import { createStatementCollector } from "./collect-statements.ts";
import type { CollectorResult } from "./coverage-accumulator.ts";
import { createCoverageAccumulator } from "./coverage-accumulator.ts";

export type { CollectorResult } from "./coverage-accumulator.ts";

export function collectCoverage(root: AstStatBlock): CollectorResult {
	const accumulator = createCoverageAccumulator();

	// The three collectors claim disjoint visitor callbacks, so one merged
	// visitor drives them all in a single walk.
	visitBlock(root, {
		...createStatementCollector(accumulator),
		...createFunctionCollector(accumulator),
		...createBranchCollector(accumulator),
	} satisfies LuauVisitor);

	return accumulator.result();
}
