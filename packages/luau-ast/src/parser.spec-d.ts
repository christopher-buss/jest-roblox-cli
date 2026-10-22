import { describe, expectTypeOf, it } from "vitest";

import type { CstParseResult } from "./cst-materialize.ts";
import type { CstBlock, CstExpr } from "./cst.ts";
import { loadLuauParser } from "./parser.ts";
import type {
	CstParseOptions,
	LuauParser,
	ParseFailure,
	ParseResult,
	ParseSuccess,
} from "./parser.ts";

describe("parser interface", () => {
	it("should separate success and diagnostics while retaining snippet types", () => {
		expectTypeOf(loadLuauParser).returns.toEqualTypeOf<LuauParser>();
		expectTypeOf<Extract<ParseResult, { ok: true }>>().toEqualTypeOf<ParseSuccess>();
		expectTypeOf<Extract<ParseResult, { ok: false }>>().toEqualTypeOf<ParseFailure>();
		expectTypeOf<LuauParser["parseCst"]>().toEqualTypeOf<
			(options: CstParseOptions) => CstParseResult
		>();
		expectTypeOf<LuauParser["constructExpression"]>().returns.toEqualTypeOf<CstExpr>();
		expectTypeOf<LuauParser["constructStatements"]>().returns.toEqualTypeOf<CstBlock>();
	});
});
