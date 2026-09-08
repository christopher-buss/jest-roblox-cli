import { describe, expect, it } from "vitest";

import { decodeLuauString } from "./string-literal.ts";

describe(decodeLuauString, () => {
	it("should strip either quote style", () => {
		expect.assertions(2);

		expect(decodeLuauString('"double"')).toBe("double");
		expect(decodeLuauString("'single'")).toBe("single");
	});

	it("should resolve character, byte, and codepoint escapes", () => {
		expect.assertions(3);

		expect(decodeLuauString(String.raw`"a\"b\\c\'d"`)).toBe(String.raw`a"b\c'd`);
		expect(decodeLuauString(String.raw`"\a\b\f\n\r\t\v"`)).toBe("\b\f\n\r\t\v");
		expect(decodeLuauString(String.raw`"\x41\65\u{1F600}"`)).toBe("AA😀");
	});

	it("should treat an escaped newline as a newline and \\z as a whitespace skip", () => {
		expect.assertions(3);

		expect(decodeLuauString('"a\\\nb"')).toBe("a\nb");
		expect(decodeLuauString('"a\\\r\nb"')).toBe("a\nb");
		expect(decodeLuauString('"a\\z  \n  b"')).toBe("ab");
	});

	it("should drop only the first newline of a long bracket", () => {
		expect.assertions(3);

		expect(decodeLuauString("[[plain]]")).toBe("plain");
		expect(decodeLuauString("[==[\r\nkeep\n]==]")).toBe("keep\n");
		expect(decodeLuauString("[=[a]]b]=]")).toBe("a]]b");
	});
});
