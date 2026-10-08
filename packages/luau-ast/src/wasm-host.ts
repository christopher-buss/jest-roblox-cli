import { Buffer } from "node:buffer";

/** The allocation surface shared by the parser and compiler wrappers. */
export interface WasmHeap {
	/** Release a source allocation. */
	free: (pointer: number) => void;
	/** Release a wrapper-owned result allocation. */
	// eslint-disable-next-line flawless/naming-convention -- C ABI symbol shared by both wrappers.
	free_result: (pointer: number) => void;
	/** Allocate the requested number of bytes. */
	malloc: (size: number) => number;
	/** The memory whose buffer may change after allocation. */
	memory: WebAssembly.Memory;
}

/** @external Emscripten's host environment import contract. */
interface EmscriptenEnvironment {
	emscripten_notify_memory_growth: () => void;
}

interface WasmCall {
	run: (sourcePointer: number, sourceLength: number) => number;
	source: string;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * Instantiate a standalone module with Emscripten's memory-growth import.
 * @param base64 - The embedded module bytes encoded as base64.
 * @returns The module's exports before its explicit initialization.
 */
export function instantiateWasm(base64: string): Record<string, unknown> {
	const module = new WebAssembly.Module(Buffer.from(base64, "base64"));
	const instance = new WebAssembly.Instance(module, {
		env: {
			emscripten_notify_memory_growth: () => {
				// Calls recreate heap views after allocation and execution.
			},
		} satisfies EmscriptenEnvironment,
	});
	return instance.exports;
}

/**
 * Transfer source through a wrapper export and release both allocations.
 * @param heap - The wrapper's allocation functions and memory.
 * @param options - The source and export to invoke with its byte coordinates.
 * @returns The decoded null-terminated wrapper payload.
 */
export function callWasm(heap: WasmHeap, { run, source }: WasmCall): string {
	const bytes = encoder.encode(source);
	const sourcePointer = heap.malloc(bytes.length + 1);
	// malloc and the wrapper may grow memory, invalidating any earlier views.
	const input = new Uint8Array(heap.memory.buffer);
	input.set(bytes, sourcePointer);
	input[sourcePointer + bytes.length] = 0;

	const resultPointer = run(sourcePointer, bytes.length);
	const output = new Uint8Array(heap.memory.buffer);
	const end = output.indexOf(0, resultPointer);
	const payload = decoder.decode(output.subarray(resultPointer, end));
	heap.free_result(resultPointer);
	heap.free(sourcePointer);
	return payload;
}
