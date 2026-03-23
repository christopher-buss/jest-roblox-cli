import { describe, expect, it } from "vitest";

import { findExpectationColumn } from "./column-finder.ts";

describe(findExpectationColumn, () => {
	it("should return undefined for empty line", () => {
		expect.assertions(1);

		expect(findExpectationColumn("")).toBeUndefined();
	});

	it("should return undefined for line without expect", () => {
		expect.assertions(1);

		expect(findExpectationColumn("const x = 5;")).toBeUndefined();
	});

	it("should find column of .toBe matcher", () => {
		expect.assertions(1);

		const line = "    expect(2 + 2).toBe(5);";

		// expect at 4, .toBe starts at 17, 'toBe' at 18 (1-indexed = 19)
		expect(findExpectationColumn(line)).toBe(19);
	});

	it("should find column of .toEqual matcher", () => {
		expect.assertions(1);

		const line = "expect(result).toEqual({ a: 1 });";

		// expect at 0, .toEqual starts at 14, 'toEqual' at 15 (1-indexed = 16)
		expect(findExpectationColumn(line)).toBe(16);
	});

	it("should find last matcher when chained", () => {
		expect.assertions(1);

		const line = "expect(value).not.toBe(undefined);";

		// .not at 13, .toBe at 17, 'toBe' at 18 (1-indexed = 19)
		expect(findExpectationColumn(line)).toBe(19);
	});

	it("should handle whitespace around dot", () => {
		expect.assertions(1);

		const line = "expect(x) . toBe(5);";

		// 'toBe' starts at 12 (1-indexed = 13)
		expect(findExpectationColumn(line)).toBe(13);
	});

	it("should return undefined if no matcher found", () => {
		expect.assertions(1);

		const line = "expect(something)";

		expect(findExpectationColumn(line)).toBeUndefined();
	});

	it("should find column of :toBe matcher in Luau colon syntax", () => {
		expect.assertions(1);

		const line = '\t\texpect(player.name):toBe("Alice")';

		// tabs at 0,1, expect at 2, ':toBe' at 21, 'toBe' at 22 (1-indexed = 23)
		expect(findExpectationColumn(line)).toBe(23);
	});

	it("should handle expect with indentation", () => {
		expect.assertions(1);

		const line = "\t\texpect(foo).toHaveBeenCalled();";

		// tabs at 0,1, expect at 2, '.' at 13, 'toHaveBeenCalled' at 14
		// (1-indexed = 15)
		expect(findExpectationColumn(line)).toBe(15);
	});

	it("should find column of expect.assertions()", () => {
		expect.assertions(1);

		const line = "            expect.assertions(2);";

		// 'assertions' at 19 (1-indexed = 20)
		expect(findExpectationColumn(line)).toBe(20);
	});

	it("should find column of indented expect.assertions()", () => {
		expect.assertions(1);

		const line = "\t\texpect.assertions(3);";

		// tabs at 0,1, expect at 2, '.assertions' at 8, 'assertions' at 9
		// (1-indexed = 10)
		expect(findExpectationColumn(line)).toBe(10);
	});
});
