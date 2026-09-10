import assert from "node:assert";
import { Buffer } from "node:buffer";

import { luauCompilerWasmBase64 } from "./luau-compiler-wasm.ts";

export interface CompilerWasmRequest {
	debugLevel: number;
	optimizationLevel: number;
	source: string;
}

export interface CompilerWasmRuntime {
	compileWithStatistics: (request: CompilerWasmRequest) => string;
}

/* eslint-disable flawless/naming-convention -- C ABI symbol names from compiler-wrapper.cpp. */
interface CompilerWasmExports {
	_initialize: () => void;
	compile_with_statistics: (
		sourcePointer: number,
		sourceLength: number,
		optimizationLevel: number,
		debugLevel: number,
	) => number;
	free: (pointer: number) => void;
	free_result: (pointer: number) => void;
	malloc: (size: number) => number;
	memory: WebAssembly.Memory;
}
/* eslint-enable flawless/naming-convention */

function isCompilerWasmExports(
	value: Record<string, unknown>,
): value is CompilerWasmExports & Record<string, unknown> {
	return (
		typeof value["_initialize"] === "function" &&
		typeof value["compile_with_statistics"] === "function" &&
		typeof value["free"] === "function" &&
		typeof value["free_result"] === "function" &&
		typeof value["malloc"] === "function" &&
		value["memory"] instanceof WebAssembly.Memory
	);
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export function createCompilerWasmRuntime(): CompilerWasmRuntime {
	const wasmModule = new WebAssembly.Module(Buffer.from(luauCompilerWasmBase64, "base64"));
	const instance = new WebAssembly.Instance(wasmModule, {
		env: {
			// eslint-disable-next-line flawless/naming-convention -- Emscripten import name.
			emscripten_notify_memory_growth: () => {
				// Heap views are rebuilt after every allocation.
			},
		},
	});
	const { exports } = instance;
	assert(isCompilerWasmExports(exports), "compiler wasm must export the wrapper surface");
	exports._initialize();
	const wasm: CompilerWasmExports = exports;

	return {
		compileWithStatistics(request) {
			return callCompiler(wasm, request);
		},
	};
}

function callCompiler(
	wasm: CompilerWasmExports,
	{ debugLevel, optimizationLevel, source }: CompilerWasmRequest,
): string {
	const sourceBytes = encoder.encode(source);
	const sourcePointer = wasm.malloc(sourceBytes.length + 1);
	const heapForWrite = new Uint8Array(wasm.memory.buffer);
	heapForWrite.set(sourceBytes, sourcePointer);
	heapForWrite[sourcePointer + sourceBytes.length] = 0;

	const resultPointer = wasm.compile_with_statistics(
		sourcePointer,
		sourceBytes.length,
		optimizationLevel,
		debugLevel,
	);
	const heapForRead = new Uint8Array(wasm.memory.buffer);
	const resultEnd = heapForRead.indexOf(0, resultPointer);
	const raw = decoder.decode(heapForRead.subarray(resultPointer, resultEnd));

	wasm.free_result(resultPointer);
	wasm.free(sourcePointer);
	return raw;
}
