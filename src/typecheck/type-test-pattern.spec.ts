import { describe, expect, it } from "vitest";

import { isLuauTypeTestFile, isTypeTestFile } from "./type-test-pattern.ts";

describe(isTypeTestFile, () => {
	it.for([
		["foo.test-d.ts", true],
		["foo.spec-d.ts", true],
		["foo.test-d.luau", true],
		["foo.spec-d.luau", true],
		["foo.test.ts", false],
		["foo.spec.ts", false],
		["foo.spec.luau", false],
		["foo.spec-d.tsx", false],
		["foo.spec-d.lua", false],
	] as const)("should classify %s as %s", ([file, expected]) => {
		expect.assertions(1);

		expect(isTypeTestFile(file)).toBe(expected);
	});
});

describe(isLuauTypeTestFile, () => {
	it.for([
		["foo.spec-d.luau", true],
		["foo.test-d.luau", true],
		["foo.spec-d.ts", false],
		["foo.spec.luau", false],
	] as const)("should classify %s as %s", ([file, expected]) => {
		expect.assertions(1);

		expect(isLuauTypeTestFile(file)).toBe(expected);
	});
});
