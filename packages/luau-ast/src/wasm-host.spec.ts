import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import { callWasm, instantiateWasm } from "./wasm-host.ts";
import type { WasmHeap } from "./wasm-host.ts";

function makeHeap() {
	const allocated: Array<number> = [];
	const freed: Array<number> = [];
	const memory = { buffer: new ArrayBuffer(65536) };
	const bytes = new Uint8Array(memory.buffer);
	bytes.fill(255);
	const heap = {
		free: (pointer: number) => {
			freed.push(pointer);
		},

		free_result: (pointer: number) => {
			freed.push(pointer);
		},
		malloc: (size: number) => {
			allocated.push(size);
			return 16;
		},
		memory,
	} satisfies WasmHeap;
	return { allocated, freed, heap, memory };
}

describe(callWasm, () => {
	it("should transfer UTF-8 source and release result and source allocations", () => {
		expect.assertions(5);

		const { allocated, freed, heap, memory } = makeHeap();
		let received: Array<number> = [];
		let coordinates: Array<number> = [];
		const payload = callWasm(heap, {
			run: (pointer, length) => {
				coordinates = [pointer, length];
				const bytes = new Uint8Array(memory.buffer);
				received = [...bytes.subarray(pointer, pointer + length + 1)];
				bytes.set([111, 107, 0], 64);
				return 64;
			},
			source: "é",
		});

		expect(coordinates).toStrictEqual([16, 2]);
		expect(allocated).toStrictEqual([3]);
		expect(received).toStrictEqual([195, 169, 0]);
		expect(freed).toStrictEqual([64, 16]);
		expect(payload).toBe("ok");
	});

	it("should decode the result after the wrapper grows memory", () => {
		expect.assertions(1);

		const { heap, memory } = makeHeap();
		const payload = callWasm(heap, {
			run: () => {
				memory.buffer = new ArrayBuffer(131072);
				const bytes = new Uint8Array(memory.buffer);
				bytes.set([110, 101, 119, 0], 65536);
				return 65536;
			},
			source: "",
		});

		expect(payload).toBe("new");
	});
});

describe(instantiateWasm, () => {
	it("should initialize a module supplied as base64 bytes", () => {
		expect.assertions(1);

		const bytes = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);

		expect(Object.keys(instantiateWasm(bytes.toString("base64")))).toStrictEqual([]);
	});
});
