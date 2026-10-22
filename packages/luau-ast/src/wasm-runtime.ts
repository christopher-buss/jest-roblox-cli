import assert from "node:assert";

import { luauParserWasmBase64 } from "./luau-parser-wasm.ts";
import { callWasm, instantiateWasm } from "./wasm-host.ts";

/** Prefixes wrapper.cpp puts on a failure payload. */
export const PARSE_ERROR_MARKER = "";
/** The prefix identifying a guarded CST serializer failure. */
export const DEFECT_MARKER = "";

/** The low-level parse surface the wasm build of the Luau parser exposes. */
export interface WasmRuntime {
	/**
	 * Arm the serializer's test hook: the next `parseToCstJson` trips the
	 * writer's own guard, so a defect is proven to come back as a message.
	 */
	injectCstFault: () => void;
	/**
	 * Parse Luau source into the position-only concrete syntax tree: tree
	 * JSON on success, {@link PARSE_ERROR_MARKER}-prefixed newline-separated
	 * errors on a parse failure, or one {@link DEFECT_MARKER}-prefixed message
	 * when the serializer caught an internal failure.
	 */
	parseToCstJson: (source: string) => string;
	/**
	 * Parse Luau source and return the wrapper's raw payload: AST JSON on
	 * success, or {@link PARSE_ERROR_MARKER}-prefixed newline-separated errors
	 * on failure.
	 */
	parseToJson: (source: string) => string;
}

/** @external C ABI symbol names from wrapper.cpp. */
interface WasmExports {
	_initialize: () => void;
	free: (pointer: number) => void;
	free_result: (pointer: number) => void;
	inject_cst_fault: () => void;
	malloc: (size: number) => number;
	memory: WebAssembly.Memory;
	parse_to_cst_json: (sourcePointer: number, sourceLength: number) => number;
	parse_to_json: (sourcePointer: number, sourceLength: number) => number;
}

/**
 * Instantiate the embedded wasm parser synchronously. The module is a
 * standalone (glue-free) Emscripten build with a single import — the memory
 * growth notification, which needs no action because heap views are created
 * fresh per call.
 *
 * @param instantiate - Host for the generated parser module's C ABI.
 * @returns The low-level parse surface.
 */
export function createWasmRuntime(
	instantiate: typeof instantiateWasm = instantiateWasm,
): WasmRuntime {
	const exports = instantiate(luauParserWasmBase64);
	assert(isWasmExports(exports), "wasm module must export the wrapper surface");
	exports._initialize();
	const wasm: WasmExports = exports;

	return {
		injectCstFault() {
			wasm.inject_cst_fault();
		},
		parseToCstJson(source) {
			return callWasm(wasm, { run: wasm.parse_to_cst_json, source });
		},
		parseToJson(source) {
			return callWasm(wasm, { run: wasm.parse_to_json, source });
		},
	};
}

function isWasmExports(
	value: Record<string, unknown>,
): value is Record<string, unknown> & WasmExports {
	return (
		typeof value["_initialize"] === "function" &&
		typeof value["free"] === "function" &&
		typeof value["free_result"] === "function" &&
		typeof value["inject_cst_fault"] === "function" &&
		typeof value["malloc"] === "function" &&
		value["memory"] instanceof WebAssembly.Memory &&
		typeof value["parse_to_cst_json"] === "function" &&
		typeof value["parse_to_json"] === "function"
	);
}
