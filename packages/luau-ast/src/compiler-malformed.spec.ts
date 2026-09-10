import { describe, expect, it, vi } from "vitest";

import { loadLuauCompiler } from "./compiler.ts";

vi.mock(import("./compiler-wasm-runtime.ts"), () => {
	return {
		createCompilerWasmRuntime: () => {
			return {
				compileWithStatistics: ({ source }: { source: string }) => source,
			};
		},
	};
});

describe("decode of a malformed compiler payload", () => {
	it.for([
		"[]",
		'{"ok":true}',
		'{"ok":true,"frames":[{}]}',
		'{"ok":false}',
		'{"ok":false,"error":{}}',
	])("should fail loudly on malformed output %s", (payload) => {
		expect.assertions(1);

		const compiler = loadLuauCompiler();

		expect(() => {
			compiler.compile(payload, { debugLevel: 2, optimizationLevel: 1 });
		}).toThrow("compiler wasm returned an unrecognized JSON shape");
	});
});
