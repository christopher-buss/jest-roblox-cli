import { fromAny } from "@total-typescript/shoehorn";

import type { CollectorResult } from "#src/coverage-pipeline/coverage-collector.ts";
import collected from "#test/fixtures/coverage-collected.json" with { type: "json" };
import andOrRhsEvalSource from "#test/fixtures/coverage-pipeline/and-or-rhs-eval.luau";
import andOrShortCircuitSource from "#test/fixtures/coverage-pipeline/and-or-short-circuit.luau";
import andOrSource from "#test/fixtures/coverage-pipeline/and-or.luau";
import directiveOnlySource from "#test/fixtures/coverage-pipeline/directive-only.luau";
import emptySource from "#test/fixtures/coverage-pipeline/empty.luau";
import exprIfSource from "#test/fixtures/coverage-pipeline/expr-if.luau";
import functionsSource from "#test/fixtures/coverage-pipeline/functions.luau";
import ifElseSource from "#test/fixtures/coverage-pipeline/if-else.luau";
import ifOnlySource from "#test/fixtures/coverage-pipeline/if-only.luau";
import ignoreDirectivesSource from "#test/fixtures/coverage-pipeline/ignore-directives.luau";
import simpleSource from "#test/fixtures/coverage-pipeline/simple.luau";
import utf8ColumnsSource from "#test/fixtures/coverage-pipeline/utf8-columns.luau";

export interface CollectedFixture {
	readonly result: CollectorResult;
	readonly source: string;
}

function fixture(result: unknown, source: string): CollectedFixture {
	return { result: fromAny<CollectorResult, unknown>(result), source };
}

export const COLLECTED_FIXTURES: Readonly<Record<string, CollectedFixture>> = {
	"and-or-rhs-eval.luau": fixture(collected["and-or-rhs-eval.luau"], andOrRhsEvalSource),
	"and-or-short-circuit.luau": fixture(
		collected["and-or-short-circuit.luau"],
		andOrShortCircuitSource,
	),
	"and-or.luau": fixture(collected["and-or.luau"], andOrSource),
	"directive-only.luau": fixture(collected["directive-only.luau"], directiveOnlySource),
	"empty.luau": fixture(collected["empty.luau"], emptySource),
	"expr-if.luau": fixture(collected["expr-if.luau"], exprIfSource),
	"functions.luau": fixture(collected["functions.luau"], functionsSource),
	"if-else.luau": fixture(collected["if-else.luau"], ifElseSource),
	"if-only.luau": fixture(collected["if-only.luau"], ifOnlySource),
	"ignore-directives.luau": fixture(collected["ignore-directives.luau"], ignoreDirectivesSource),
	"simple.luau": fixture(collected["simple.luau"], simpleSource),
	"utf8-columns.luau": fixture(collected["utf8-columns.luau"], utf8ColumnsSource),
};
