/**
 * The slice of the WebAssembly JS API wasm-runtime.ts uses. Node provides the
 * global at runtime, but `@types/node` leaves the types to `lib.dom` — which
 * this Node-only package deliberately does not load.
 */
declare namespace WebAssembly {
	interface Instance {
		readonly exports: Record<string, unknown>;
	}

	interface Memory {
		readonly buffer: ArrayBuffer;
	}

	interface Module {
		readonly __brand: "WebAssemblyModule";
	}

	const Instance: new (
		module: Module,
		imports: Record<string, Record<string, unknown>>,
	) => Instance;
	const Memory: new (descriptor: { initial: number }) => Memory;
	const Module: new (bytes: Uint8Array) => Module;
}
