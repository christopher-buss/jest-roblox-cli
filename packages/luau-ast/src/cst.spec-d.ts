import { describe, expectTypeOf, it } from "vitest";

import type { LuauSpan } from "./ast-types.ts";
import { forEachToken, walkCst } from "./cst.ts";
import type { CstExpr, CstNode, CstNodeKind, CstNumber, CstValue, Token } from "./cst.ts";

describe("CST interface", () => {
	it("should retain exhaustive kinds and optional token origins", () => {
		expectTypeOf<CstNode["type"]>().toEqualTypeOf<CstNodeKind>();
		expectTypeOf<Extract<CstExpr, { type: "Number" }>>().toEqualTypeOf<CstNumber>();
		expectTypeOf<Token["origin"]>().toEqualTypeOf<LuauSpan | undefined>();
		expectTypeOf(forEachToken).toEqualTypeOf<
			(value: CstValue, visit: (token: Token) => void) => void
		>();
		expectTypeOf(walkCst).returns.toEqualTypeOf<void>();
	});
});
