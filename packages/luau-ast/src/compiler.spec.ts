import { describe, expect, it } from "vitest";

import type { CompilerWasmRuntime } from "./compiler-wasm-runtime.ts";
import { loadLuauCompiler } from "./compiler.ts";

describe(loadLuauCompiler, () => {
	it("should omit the bytecode listing by default", () => {
		expect.assertions(2);

		const requests: Array<Parameters<CompilerWasmRuntime["compileWithStatistics"]>[0]> = [];
		const compiler = loadLuauCompiler({
			compileWithStatistics: (request) => {
				requests.push(request);
				return '{"ok":true,"frames":[]}';
			},
		});
		const result = compiler.compile("return 1", { debugLevel: 2, optimizationLevel: 1 });

		expect(requests).toStrictEqual([
			{ bytecodeText: false, debugLevel: 2, optimizationLevel: 1, source: "return 1" },
		]);
		expect(result).toStrictEqual({ frames: [], ok: true });
	});
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

		const compiler = loadLuauCompiler({ compileWithStatistics: ({ source }) => source });

		expect(() => {
			compiler.compile(payload, { debugLevel: 2, optimizationLevel: 1 });
		}).toThrow("compiler wasm returned an unrecognized JSON shape");
	});
});
