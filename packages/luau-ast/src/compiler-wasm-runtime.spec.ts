import { describe, expect, it } from "vitest";

import { createCompilerWasmRuntime } from "./compiler-wasm-runtime.ts";

describe(createCompilerWasmRuntime, () => {
	it("should return compiler payloads across repeated calls", () => {
		expect.assertions(2);

		const runtime = createCompilerWasmRuntime();
		const request = {
			bytecodeText: true,
			debugLevel: 2,
			optimizationLevel: 1,
			source: "return 1",
		};
		const first = runtime.compileWithStatistics(request);

		expect(first).toContain('"ok":true');
		expect(runtime.compileWithStatistics(request)).toBe(first);
	});

	it("should report compiler errors in the wrapper payload", () => {
		expect.assertions(1);

		const runtime = createCompilerWasmRuntime();

		expect(
			runtime.compileWithStatistics({
				bytecodeText: false,
				debugLevel: 0,
				optimizationLevel: 0,
				source: "local =",
			}),
		).toContain('"ok":false');
	});
});
