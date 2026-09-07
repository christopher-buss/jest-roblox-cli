import { describe, expect, it } from "vitest";

import { createIgnoreMatcher, readGlobIgnorePaths } from "./glob-ignore.ts";

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
});
