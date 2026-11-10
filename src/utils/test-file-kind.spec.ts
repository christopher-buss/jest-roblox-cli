import { describe, expect, it } from "vitest";

import {
	isLuauTestFile,
	isLuauTypeTestFile,
	isTypeTestFile,
	sourceTwinOf,
	toRobloxTestMatch,
	toRobloxTestPathIgnorePatterns,
	toTypeTestPattern,
} from "./test-file-kind.ts";

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
		["foo_spec-d.ts", false],
		["foo.spec-d/ts", false],
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
		["foo_spec-d.luau", false],
		["foo.spec-d/luau", false],
	] as const)("should classify %s as %s", ([file, expected]) => {
		expect.assertions(1);

		expect(isLuauTypeTestFile(file)).toBe(expected);
	});
});

describe(toTypeTestPattern, () => {
	it.for([
		["src/**/*.spec.ts", "src/**/*.spec-d.ts"],
		["src/**/*.test.luau", "src/**/*.test-d.luau"],
		["src/**/*.spec.tsx", "src/**/*.spec.tsx"],
		["src/**/*_spec.ts", "src/**/*_spec.ts"],
		["src/**/*.spec/ts", "src/**/*.spec/ts"],
	] as const)("should turn %s into %s", ([pattern, expected]) => {
		expect.assertions(1);

		expect(toTypeTestPattern(pattern)).toBe(expected);
	});
});

describe(toRobloxTestMatch, () => {
	it("should strip .ts and drop the type-test globs", () => {
		expect.assertions(1);

		expect(
			toRobloxTestMatch(["**/*.spec.ts", "**/*.spec-d.ts", "**/*.test-d.luau"]),
		).toStrictEqual(["**/*.spec"]);
	});
});

describe(toRobloxTestPathIgnorePatterns, () => {
	it("should add the type-test pattern once", () => {
		expect.assertions(1);

		expect(
			toRobloxTestPathIgnorePatterns(["/out/", String.raw`\.(spec|test)-d$`]),
		).toStrictEqual(["/out/", String.raw`\.(spec|test)-d$`]);
	});
});

describe(sourceTwinOf, () => {
	it.for([
		["/r/src/a.spec.ts", "/r/src/a.ts"],
		["/r/src/a.test.luau", "/r/src/a.luau"],
		["/r/src/a.spec-d.ts", "/r/src/a.ts"],
		["/r/src/a.ts", "/r/src/a.ts"],
		["/r/src/a.spec.d/b.ts", "/r/src/a.spec.d/b.ts"],
	] as const)("should map %s to %s", ([file, twin]) => {
		expect.assertions(1);

		expect(sourceTwinOf(file)).toBe(twin);
	});
});

describe(isLuauTestFile, () => {
	it.for(["a.spec.luau", "a.test.luau", "a.spec.lua", "a.test.lua"])(
		"should accept %s",
		(file) => {
			expect.assertions(1);

			expect(isLuauTestFile(file)).toBeTrue();
		},
	);

	it.for(["a.luau", "a.spec.ts", "a.spec-d.luau", "a.snap.luau", "a.spec.luau.bak"])(
		"should reject %s",
		(file) => {
			expect.assertions(1);

			expect(isLuauTestFile(file)).toBeFalse();
		},
	);
});
