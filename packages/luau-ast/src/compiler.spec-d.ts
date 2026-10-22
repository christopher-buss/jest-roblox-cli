import { describe, expectTypeOf, it } from "vitest";

import { loadLuauCompiler } from "./compiler.ts";
import type {
	LuauCompileFailure,
	LuauCompileLevel,
	LuauCompileOptions,
	LuauCompiler,
	LuauCompileResult,
	LuauCompileSuccess,
} from "./compiler.ts";

describe("compiler interface", () => {
	it("should constrain settings and discriminate compilation results", () => {
		expectTypeOf(loadLuauCompiler).returns.toEqualTypeOf<LuauCompiler>();
		expectTypeOf<LuauCompileLevel>().toEqualTypeOf<0 | 1 | 2>();
		expectTypeOf<{ debugLevel: 3; optimizationLevel: 1 }>().not.toExtend<LuauCompileOptions>();
		expectTypeOf<
			Extract<LuauCompileResult, { ok: true }>
		>().toEqualTypeOf<LuauCompileSuccess>();
		expectTypeOf<
			Extract<LuauCompileResult, { ok: false }>
		>().toEqualTypeOf<LuauCompileFailure>();
		expectTypeOf<LuauCompiler["compile"]>().toEqualTypeOf<
			(source: string, options: LuauCompileOptions) => LuauCompileResult
		>();
	});
});
