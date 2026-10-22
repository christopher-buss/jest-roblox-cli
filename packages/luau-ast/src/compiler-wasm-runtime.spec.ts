import { describe, expect, it, vi } from "vitest";

import { createCompilerWasmRuntime } from "./compiler-wasm-runtime.ts";

function compilerExports() {
	const compile = vi.fn<(...args: Array<number>) => number>(() => 512);
	const initialize = vi.fn<() => void>();
	const exports = Object.fromEntries([
		["_initialize", initialize],
		["compile_with_statistics", compile],
		["free", () => {}],
		["free_result", () => {}],
		["malloc", () => 16],
		["memory", new WebAssembly.Memory({ initial: 1 })],
	]);
	return { compile, exports, initialize };
}

describe(createCompilerWasmRuntime, () => {
	it.for(["_initialize", "compile_with_statistics", "free", "free_result", "malloc", "memory"])(
		"should reject an invalid %s export",
		(key) => {
			expect.assertions(1);

			const { exports } = compilerExports();
			Reflect.set(exports, key, undefined);

			expect(() => createCompilerWasmRuntime(() => exports)).toThrow(
				"compiler wasm must export the wrapper surface",
			);
		},
	);

	it.for([false, true])(
		"should pass explicit compiler settings and listing flag %s",
		(bytecodeText) => {
			expect.assertions(2);

			const { compile, exports, initialize } = compilerExports();
			const runtime = createCompilerWasmRuntime(() => exports);

			runtime.compileWithStatistics({
				bytecodeText,
				debugLevel: 2,
				optimizationLevel: 1,
				source: "∞",
			});

			expect(initialize).toHaveBeenCalledExactlyOnceWith();
			expect(compile).toHaveBeenCalledExactlyOnceWith(16, 3, 1, 2, Number(bytecodeText));
		},
	);

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
