import { describe, expectTypeOf, it } from "vitest";

import type { AstExpr, AstStat, AstStatBlock } from "./ast-types.ts";
import { visitBlock, visitExpression, visitStatement } from "./visit.ts";
import type { LuauVisitor } from "./visit.ts";

describe("visitor interface", () => {
	it("should type callbacks by node kind and require boolean descent decisions", () => {
		expectTypeOf(visitBlock).toEqualTypeOf<
			(block: AstStatBlock, visitor: LuauVisitor) => void
		>();
		expectTypeOf(visitExpression).toEqualTypeOf<
			(node: AstExpr, visitor: LuauVisitor) => void
		>();
		expectTypeOf(visitStatement).toEqualTypeOf<(node: AstStat, visitor: LuauVisitor) => void>();
		expectTypeOf<LuauVisitor["visitExpr"]>().toEqualTypeOf<
			((node: AstExpr) => boolean) | undefined
		>();
		expectTypeOf<{ visitExpr: (node: AstExpr) => void }>().not.toExtend<LuauVisitor>();
	});
});
