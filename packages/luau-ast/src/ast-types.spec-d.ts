import { describe, expectTypeOf, it } from "vitest";

import type {
	AstExpr,
	AstExprBinary,
	AstStat,
	AstStatBlock,
	BinaryOp,
	LuauSpan,
} from "./ast-types.ts";

describe("AST types", () => {
	it("should discriminate node variants and preserve numeric span coordinates", () => {
		expectTypeOf<Extract<AstExpr, { type: "AstExprBinary" }>>().toEqualTypeOf<AstExprBinary>();
		expectTypeOf<Extract<AstStat, { type: "AstStatBlock" }>>().toEqualTypeOf<AstStatBlock>();
		expectTypeOf<AstExprBinary["op"]>().toEqualTypeOf<BinaryOp>();
		expectTypeOf<LuauSpan>().toEqualTypeOf<{
			beginColumn: number;
			beginLine: number;
			endColumn: number;
			endLine: number;
		}>();
	});
});
