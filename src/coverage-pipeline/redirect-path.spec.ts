import { describe, expect, it } from "vitest";

import { posixRoot } from "#test/mocks/posix-path.ts";
import { isWithinRoot, redirectPathToShadow } from "./redirect-path.ts";

describe(isWithinRoot, () => {
	it.for<[string, boolean]>([
		["out", true],
		["out/shared/a.luau", true],
		["out-tsc", false],
		["other/out", false],
	])("should place %s inside out: %s", ([target, expected]) => {
		expect.assertions(1);

		expect(isWithinRoot(target, "out")).toBe(expected);
	});
});

describe(redirectPathToShadow, () => {
	function roots() {
		return [
			{ luauRoot: posixRoot("out"), shadowDir: ".shadow/out" },
			{ luauRoot: posixRoot("lib"), shadowDir: ".shadow/lib" },
		];
	}

	it("should rewrite a path inside a root into its shadow", () => {
		expect.assertions(1);

		expect(redirectPathToShadow("lib/shared/a.luau", roots())).toBe(
			".shadow/lib/shared/a.luau",
		);
	});

	it("should land an exact root on the shadow directory itself", () => {
		expect.assertions(1);

		expect(redirectPathToShadow("out", roots())).toBe(".shadow/out");
	});

	it("should return undefined for a path outside every root", () => {
		expect.assertions(1);

		expect(redirectPathToShadow("out-tsc/a.luau", roots())).toBeUndefined();
	});
});
