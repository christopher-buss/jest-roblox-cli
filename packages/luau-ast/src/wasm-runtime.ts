import assert from "node:assert";
import { Buffer } from "node:buffer";

import { luauParserWasmBase64 } from "./luau-parser-wasm.ts";

/** The low-level parse surface the wasm build of the Luau parser exposes. */
export interface WasmRuntime {
	/**
	 * Parse Luau source and return the wrapper's raw payload: AST JSON on
	 * success, or ``-prefixed newline-separated errors on failure.
	 */
	parseToJson: (source: string) => string;
}

/** The C symbols wrapper.cpp exports (see wasm/build-wasm.ts). */
/* eslint-disable flawless/naming-convention -- C ABI symbol names from wrapper.cpp. */
interface WasmExports {
	_initialize: () => void;
	free: (pointer: number) => void;
	free_result: (pointer: number) => void;
	malloc: (size: number) => number;
	memory: WebAssembly.Memory;
	parse_to_json: (sourcePointer: number, sourceLength: number) => number;
}
/* eslint-enable flawless/naming-convention */

function isWasmExports(
	value: Record<string, unknown>,
): value is Record<string, unknown> & WasmExports {
	return (
		typeof value["_initialize"] === "function" &&
		typeof value["free"] === "function" &&
		typeof value["free_result"] === "function" &&
		typeof value["malloc"] === "function" &&
		typeof value["memory"] === "object" &&
		typeof value["parse_to_json"] === "function"
	);
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * Instantiate the embedded wasm parser synchronously. The module is a
 * standalone (glue-free) Emscripten build with a single import — the memory
 * growth notification, which needs no action because heap views are created
 * fresh per call.
 *
 * @returns The low-level parse surface.
 */
export function createWasmRuntime(): WasmRuntime {
	const wasmModule = new WebAssembly.Module(Buffer.from(luauParserWasmBase64, "base64"));
	const instance = new WebAssembly.Instance(wasmModule, {
		env: {
			// eslint-disable-next-line flawless/naming-convention -- Emscripten import name.
			emscripten_notify_memory_growth: () => {
				// Heap views are rebuilt from memory.buffer on every access, so
				// growth needs no bookkeeping here.
			},
		},
	});
	const { exports } = instance;
	assert(isWasmExports(exports), "wasm module must export the wrapper surface");
	exports._initialize();

	return {
		parseToJson(source) {
			const sourceBytes = encoder.encode(source);
			const sourcePointer = exports.malloc(sourceBytes.length + 1);
			// The view is created after malloc: allocation can grow (and so
			// detach) the backing buffer.
			const heapForWrite = new Uint8Array(exports.memory.buffer);
			heapForWrite.set(sourceBytes, sourcePointer);
			heapForWrite[sourcePointer + sourceBytes.length] = 0;

			const resultPointer = exports.parse_to_json(sourcePointer, sourceBytes.length);
			const heapForRead = new Uint8Array(exports.memory.buffer);
			const resultEnd = heapForRead.indexOf(0, resultPointer);
			const raw = decoder.decode(heapForRead.subarray(resultPointer, resultEnd));

			exports.free_result(resultPointer);
			exports.free(sourcePointer);
			return raw;
		},
	};
}
