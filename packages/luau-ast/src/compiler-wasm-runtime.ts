import assert from "node:assert";

import { luauCompilerWasmBase64 } from "./luau-compiler-wasm.ts";
import { callWasm, instantiateWasm } from "./wasm-host.ts";

/** The raw JSON surface exposed by the compiler wrapper. */
export interface CompilerWasmRuntime {
	/** Compile source and return the wrapper JSON payload. */
	compileWithStatistics: (request: CompilerWasmRequest) => string;
}

/** The source and numeric settings passed to the compiler wrapper. */
interface CompilerWasmRequest {
	/** The optional bytecode listing with compiler remarks. */
	bytecodeText: boolean;
	/** The amount of debug information retained in the bytecode. */
	debugLevel: number;
	/** The optimization setting passed to the compiler. */
	optimizationLevel: number;
	/** The Luau source passed to the backend. */
	source: string;
}

/* eslint-disable flawless/naming-convention -- C ABI symbol names from compiler-wrapper.cpp. */
interface CompilerWasmExports {
	_initialize: () => void;
	compile_with_statistics: (
		sourcePointer: number,
		sourceLength: number,
		optimizationLevel: number,
		debugLevel: number,
		bytecodeText: number,
	) => number;
	free: (pointer: number) => void;
	free_result: (pointer: number) => void;
	malloc: (size: number) => number;
	memory: WebAssembly.Memory;
}
/* eslint-enable flawless/naming-convention */

/**
 * Instantiate the embedded compiler and expose its raw payloads.
 * @returns The initialized compiler backend.
 */
export function createCompilerWasmRuntime(): CompilerWasmRuntime {
	const exports = instantiateWasm(luauCompilerWasmBase64);
	// Stryker disable next-line StringLiteral: Pinned wasm ABI never fails.
	assert(isCompilerWasmExports(exports), "compiler wasm must export the wrapper surface");
	exports._initialize();
	const wasm: CompilerWasmExports = exports;

	return {
		compileWithStatistics(request) {
			return callCompiler(wasm, request);
		},
	};
}

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

function callCompiler(
	wasm: CompilerWasmExports,
	{ bytecodeText, debugLevel, optimizationLevel, source }: CompilerWasmRequest,
): string {
	return callWasm(wasm, {
		run: (sourcePointer, sourceLength) => {
			return wasm.compile_with_statistics(
				sourcePointer,
				sourceLength,
				optimizationLevel,
				debugLevel,
				bytecodeText ? 1 : 0,
			);
		},
		source,
	});
}
