import { describe, expect, it, vi } from "vitest";

import { createWasmRuntime, DEFECT_MARKER } from "./wasm-runtime.ts";

function parserExports() {
	const initialize = vi.fn<() => void>();
	const exports = Object.fromEntries<readonly [string, unknown]>([
		["_initialize", initialize],
		["free", () => {}],
		["free_result", () => {}],
		["inject_cst_fault", () => {}],
		["malloc", () => 0],
		["memory", new WebAssembly.Memory({ initial: 1 })],
		["parse_to_cst_json", () => 0],
		["parse_to_json", () => 0],
	]);
	return { exports, initialize };
}

describe(createWasmRuntime, () => {
	it("should return a guarded serializer fault and recover on the next call", () => {
		expect.assertions(2);

		const runtime = createWasmRuntime();
		runtime.injectCstFault();

		expect(runtime.parseToCstJson("local x = 1")).toBe(
			`${DEFECT_MARKER}cst writer: close without a matching open`,
		);
		expect(runtime.parseToCstJson("local x = 1")).toStartWith("{");
	});

	it.for([
		"_initialize",
		"free",
		"free_result",
		"inject_cst_fault",
		"malloc",
		"memory",
		"parse_to_cst_json",
		"parse_to_json",
	])("should reject an invalid %s export", (key) => {
		expect.assertions(1);

		const { exports } = parserExports();
		Reflect.set(exports, key, undefined);

		expect(() => createWasmRuntime(() => exports)).toThrow(
			"wasm module must export the wrapper surface",
		);
	});

	it("should return AST payloads across repeated calls", () => {
		expect.assertions(3);

		const runtime = createWasmRuntime();

		expect(runtime.parseToJson("return 3")).toContain('"value":3');
		expect(runtime.parseToJson("local =")).toStartWith("\u0001");
		expect(runtime.parseToJson("return 4")).toContain('"value":4');
	});

	it("should initialize an injected backend once", () => {
		expect.assertions(1);

		const { exports, initialize } = parserExports();
		createWasmRuntime(() => exports);

		expect(initialize).toHaveBeenCalledExactlyOnceWith();
	});
});
