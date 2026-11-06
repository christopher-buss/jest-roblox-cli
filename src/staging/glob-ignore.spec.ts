import { describe, expect, it } from "vitest";

import {
	createIgnoreMatcher,
	readDeclaredGlobIgnorePaths,
	readGlobIgnorePaths,
	withReplacedConfigs,
} from "./glob-ignore.ts";

describe(readGlobIgnorePaths, () => {
	it("should read the declared strings and drop everything else", () => {
		expect.assertions(1);

		expect(
			readGlobIgnorePaths({ globIgnorePaths: ["out/**", 7, null, "src/*"] }),
		).toStrictEqual(["out/**", "src/*"]);
	});

	it("should answer none for a project that declares no list", () => {
		expect.assertions(1);

		expect(readGlobIgnorePaths({})).toStrictEqual([]);
	});
});

describe(readDeclaredGlobIgnorePaths, () => {
	it("should tell a declared empty list apart from no list", () => {
		expect.assertions(2);

		expect(readDeclaredGlobIgnorePaths({ globIgnorePaths: [] })).toStrictEqual([]);
		expect(readDeclaredGlobIgnorePaths({})).toBeUndefined();
	});
});

describe(withReplacedConfigs, () => {
	it("should keep the declared list as is when no config is replaced", () => {
		expect.assertions(2);

		const declared = ["**/*.txt"];

		expect(withReplacedConfigs(declared, [])).toBe(declared);
		expect(withReplacedConfigs(undefined, [])).toBeUndefined();
	});

	it("should append each replaced config once after the declared patterns", () => {
		expect.assertions(2);

		expect(
			withReplacedConfigs(["**/*.txt"], ["/a/jest.config.luau", "/a/jest.config.luau"]),
		).toStrictEqual(["**/*.txt", "/a/jest.config.luau"]);
		expect(withReplacedConfigs(undefined, ["/a/jest.config.lua"])).toStrictEqual([
			"/a/jest.config.lua",
		]);
	});
});

describe(createIgnoreMatcher, () => {
	it("should never build a matcher for a project that drops nothing", () => {
		expect.assertions(2);

		const matcher = createIgnoreMatcher([]);

		// The saving the fast path exists for: the split asks this of every
		// file it walks, so a matcher that can only ever answer no must cost
		// nothing to build or to ask. One shared function is what says the
		// empty case never reached picomatch, which builds a fresh one.
		expect(matcher("D:/repo/out/thing.luau")).toBeFalse();
		expect(matcher).toBe(createIgnoreMatcher([]));
	});

	it("should match a declared pattern with and without the drive letter", () => {
		expect.assertions(3);

		const matcher = createIgnoreMatcher(["**/out/**"]);

		expect(matcher("D:\\repo\\out\\thing.luau")).toBeTrue();
		expect(matcher("/repo/out/thing.luau")).toBeTrue();
		expect(matcher("/repo/src/thing.luau")).toBeFalse();
	});

	it("should match a path through a dot-directory", () => {
		expect.assertions(1);

		expect(createIgnoreMatcher(["**/out/**"])("/repo/.cache/out/thing.luau")).toBeTrue();
	});
});
