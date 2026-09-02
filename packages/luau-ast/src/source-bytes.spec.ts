import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import type { LuauSpan } from "./ast.ts";
import { indexSourceBytes } from "./source-bytes.ts";

function span(overrides: Partial<LuauSpan>): LuauSpan {
	return {
		beginColumn: 1,
		beginLine: 1,
		endColumn: 1,
		endLine: 1,
		...overrides,
	};
}

describe(indexSourceBytes, () => {
	it("should convert spans on the first line to byte ranges", () => {
		expect.assertions(1);

		const bytes = indexSourceBytes("local x = 1\n");
		const range = bytes.spanToRange(span({ beginColumn: 7, endColumn: 8 }));

		expect(bytes.slice(range.start, range.end)).toBe("x");
	});

	it("should convert spans on later lines using byte line starts", () => {
		expect.assertions(1);

		const bytes = indexSourceBytes("local a = 1\nlocal bc = 2\n");
		const range = bytes.spanToRange(
			span({ beginColumn: 7, beginLine: 2, endColumn: 9, endLine: 2 }),
		);

		expect(bytes.slice(range.start, range.end)).toBe("bc");
	});

	it("should count multi-byte characters as multiple bytes", () => {
		expect.assertions(2);

		// "∞" is three UTF-8 bytes but one UTF-16 unit; the identifier after it
		// only resolves correctly under byte offsets.
		const source = 'local s = "∞"\nlocal y = 2\n';
		const bytes = indexSourceBytes(source);

		expect(bytes.byteLength).toBe(Buffer.byteLength(source, "utf-8"));

		const range = bytes.spanToRange(
			span({ beginColumn: 7, beginLine: 2, endColumn: 8, endLine: 2 }),
		);

		expect(bytes.slice(range.start, range.end)).toBe("y");
	});

	it("should slice a span back to its text", () => {
		expect.assertions(1);

		const bytes = indexSourceBytes("line1\nlocal x = a >= b\nline3");

		expect(
			bytes.sliceSpan(span({ beginColumn: 13, beginLine: 2, endColumn: 15, endLine: 2 })),
		).toBe(">=");
	});

	// "∞" is three bytes and one UTF-16 unit, so `x` starts at byte column 20
	// but UTF-16 column 18.
	it("should slice a span past a multi-byte character by bytes", () => {
		expect.assertions(1);

		const bytes = indexSourceBytes('local a = "\u{221E}" .. x');

		expect(bytes.sliceSpan(span({ beginColumn: 20, endColumn: 21 }))).toBe("x");
	});

	it("should report line ends as the start of the next line", () => {
		expect.assertions(2);

		const bytes = indexSourceBytes("ab\ncd");

		expect(bytes.lineEndOffset(1)).toBe(3);
		// Final line without a trailing newline ends at the source length.
		expect(bytes.lineEndOffset(2)).toBe(5);
	});

	it("should expose bytes by offset and undefined past the end", () => {
		expect.assertions(2);

		const bytes = indexSourceBytes("a");

		expect(bytes.byteAt(0)).toBe(0x61);
		expect(bytes.byteAt(1)).toBeUndefined();
	});

	it("should keep the text it was built from", () => {
		expect.assertions(1);

		expect(indexSourceBytes("local x = 1").text).toBe("local x = 1");
	});

	it("should throw when a span names a line outside the source", () => {
		expect.assertions(1);

		const bytes = indexSourceBytes("ab");

		expect(() => {
			bytes.lineStartOffset(3);
		}).toThrow("line 3 is outside the source");
	});
});

describe("byte columns as UTF-16 columns", () => {
	it("should leave the columns of an all-ASCII line alone", () => {
		expect.assertions(1);

		const bytes = indexSourceBytes("local x = 1\n");

		expect(bytes.toUtf16Column(1, 11)).toBe(11);
	});

	// `local a = "∞" 1` — the closing quote is byte column 15 and UTF-16
	// column 13, because U+221E is three bytes and one UTF-16 unit.
	it("should subtract the extra bytes of a preceding character", () => {
		expect.assertions(2);

		const bytes = indexSourceBytes('local a = "\u{221E}" 1\n');

		expect(bytes.toUtf16Column(1, 11)).toBe(11);
		expect(bytes.toUtf16Column(1, 15)).toBe(13);
	});

	// An astral character is four bytes but two UTF-16 units, so a column past
	// it drifts by two rather than by three.
	it("should count an astral character as two UTF-16 units", () => {
		expect.assertions(1);

		const bytes = indexSourceBytes('local a = "\u{1F389}"\n');

		expect(bytes.toUtf16Column(1, 16)).toBe(14);
	});

	// A span that ends the line ends one byte past it, which is one UTF-16
	// unit past it too.
	it("should convert an end column that sits past the last byte", () => {
		expect.assertions(1);

		const bytes = indexSourceBytes('local a = "\u{221E}"\n');

		expect(bytes.toUtf16Column(1, 16)).toBe(14);
	});

	it("should count a carriage return as part of the line it ends", () => {
		expect.assertions(1);

		const bytes = indexSourceBytes('local a = "\u{221E}"\r\nlocal b = 2\r\n');

		expect(bytes.toUtf16Column(1, 15)).toBe(13);
	});

	it("should convert each line against its own bytes", () => {
		expect.assertions(2);

		const bytes = indexSourceBytes('local a = "\u{221E}"\nlocal b = "yes"\n');

		expect(bytes.toUtf16Column(1, 15)).toBe(13);
		expect(bytes.toUtf16Column(2, 16)).toBe(16);
	});

	it("should convert a byte range on the first line back to a span", () => {
		expect.assertions(1);

		const bytes = indexSourceBytes("local x = 1\nlocal y = 2\n");

		expect(bytes.rangeToSpan({ end: 7, start: 6 })).toStrictEqual(
			span({ beginColumn: 7, endColumn: 8 }),
		);
	});

	it("should convert a byte range on a later line back to a span", () => {
		expect.assertions(1);

		const bytes = indexSourceBytes("local a = 1\nlocal b = 2\nlocal cd = 3\n");

		expect(bytes.rangeToSpan({ end: 32, start: 30 })).toStrictEqual(
			span({ beginColumn: 7, beginLine: 3, endColumn: 9, endLine: 3 }),
		);
	});

	it("should convert a byte range that crosses a line back to a span", () => {
		expect.assertions(1);

		const bytes = indexSourceBytes("ab\ncd\nef\n");

		expect(bytes.rangeToSpan({ end: 7, start: 1 })).toStrictEqual(
			span({ beginColumn: 2, beginLine: 1, endColumn: 2, endLine: 3 }),
		);
	});

	it("should answer column 1 for an offset that sits on a line start", () => {
		expect.assertions(1);

		const bytes = indexSourceBytes("ab\ncd\n");

		expect(bytes.rangeToSpan({ end: 5, start: 3 })).toStrictEqual(
			span({ beginColumn: 1, beginLine: 2, endColumn: 3, endLine: 2 }),
		);
	});

	it("should round-trip a span through byte offsets", () => {
		expect.assertions(1);

		// Multi-byte characters shift byte columns away from UTF-16 ones, so a
		// round trip that survives them is doing byte math both ways.
		const bytes = indexSourceBytes('local a = "\u{221E}"\nlocal bc = "\u{1F389}"\n');
		const original = span({ beginColumn: 7, beginLine: 2, endColumn: 9, endLine: 2 });

		expect(bytes.rangeToSpan(bytes.spanToRange(original))).toStrictEqual(original);
	});
});
