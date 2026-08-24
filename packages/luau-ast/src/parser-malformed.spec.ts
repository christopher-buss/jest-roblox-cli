import { describe, expect, it, vi } from "vitest";

import { loadLuauParser } from "./parser.ts";

// Fakes the wasm runtime so the wrapper can return shapes the real parser
// never produces; the decode layer must fail loudly rather than mis-brand.
vi.mock(import("./wasm-runtime.ts"), () => {
	return {
		createWasmRuntime: () => {
			return {
				// Echo the source back so each test drives the decoder with a
				// hand-crafted payload.
				parseToJson: (source: string) => source,
			};
		},
	};
});

describe("decode of a malformed wrapper payload", () => {
	it("should fail loudly when the JSON is not a parse output", () => {
		expect.assertions(1);

		const parser = loadLuauParser();

		expect(() => parser.parse('{"unexpected": true}')).toThrow(
			"wasm wrapper returned an unrecognized JSON shape",
		);
	});

	it("should fail loudly when the JSON is not even an object", () => {
		expect.assertions(1);

		const parser = loadLuauParser();

		expect(() => parser.parse("[1, 2]")).toThrow(
			"wasm wrapper returned an unrecognized JSON shape",
		);
	});

	it("should fail loudly on an unrecognized location string", () => {
		expect.assertions(1);

		const parser = loadLuauParser();

		expect(() => parser.parse('{"location": "not a span"}')).toThrow(
			"unrecognized location string",
		);
	});
});
