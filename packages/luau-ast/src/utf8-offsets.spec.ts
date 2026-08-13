import { describe, expect, it } from "vitest";

import { createUtf8OffsetMap } from "./utf8-offsets.ts";

describe(createUtf8OffsetMap, () => {
	it("should map ASCII byte offsets one to one", () => {
		expect.assertions(4);

		const { byteLength, toUtf16 } = createUtf8OffsetMap("hello");

		expect(byteLength).toBe(5);
		expect(toUtf16(0)).toBe(0);
		expect(toUtf16(3)).toBe(3);
		expect(toUtf16(5)).toBe(5);
	});

	it("should count a two-byte character as one UTF-16 unit", () => {
		expect.assertions(2);

		const { byteLength, toUtf16 } = createUtf8OffsetMap("éx");

		expect(byteLength).toBe(3);
		expect(toUtf16(2)).toBe(1);
	});

	it("should count a three-byte character as one UTF-16 unit", () => {
		expect.assertions(2);

		const { byteLength, toUtf16 } = createUtf8OffsetMap("漢x");

		expect(byteLength).toBe(4);
		expect(toUtf16(3)).toBe(1);
	});

	it("should count a four-byte character as two UTF-16 units", () => {
		expect.assertions(2);

		const { byteLength, toUtf16 } = createUtf8OffsetMap("🚀x");

		expect(byteLength).toBe(5);
		expect(toUtf16(4)).toBe(2);
	});

	it("should resolve an offset inside a character to where it starts", () => {
		expect.assertions(2);

		const { toUtf16 } = createUtf8OffsetMap("a🚀");

		expect(toUtf16(2)).toBe(1);
		expect(toUtf16(4)).toBe(1);
	});

	it("should clamp an offset outside the text to its nearest end", () => {
		expect.assertions(2);

		const { toUtf16 } = createUtf8OffsetMap("é");

		expect(toUtf16(-1)).toBe(0);
		expect(toUtf16(99)).toBe(1);
	});

	it("should map the empty text to a single zero offset", () => {
		expect.assertions(2);

		const { byteLength, toUtf16 } = createUtf8OffsetMap("");

		expect(byteLength).toBe(0);
		expect(toUtf16(0)).toBe(0);
	});
});
