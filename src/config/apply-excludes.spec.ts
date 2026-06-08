import { describe, expect, it } from "vitest";

import { applyExcludes } from "./apply-excludes.ts";

describe(applyExcludes, () => {
	it("should drop files matching an exclude glob", () => {
		expect.assertions(1);

		const files = ["src/a.spec.ts", "src/legacy/b.spec.ts"];

		expect(applyExcludes(files, ["**/legacy/**"])).toStrictEqual(["src/a.spec.ts"]);
	});

	it("should return the input untouched when excludeGlobs is undefined", () => {
		expect.assertions(1);

		const files = ["src/a.spec.ts", "src/b.spec.ts"];

		expect(applyExcludes(files, undefined)).toBe(files);
	});

	it("should return the input untouched when excludeGlobs is empty", () => {
		expect.assertions(1);

		const files = ["src/a.spec.ts", "src/b.spec.ts"];

		expect(applyExcludes(files, [])).toBe(files);
	});

	it("should treat regex metacharacters in a glob as literals", () => {
		expect.assertions(1);

		const files = ["src/(gen)/a.spec.ts", "src/genX/b.spec.ts"];

		expect(applyExcludes(files, ["**/(gen)/**"])).toStrictEqual(["src/genX/b.spec.ts"]);
	});

	it("should keep every file when no glob matches", () => {
		expect.assertions(1);

		const files = ["src/a.spec.ts", "src/b.spec.ts"];

		expect(applyExcludes(files, ["**/*.gen.spec.ts"])).toStrictEqual(files);
	});

	it("should drop files matching any of several globs", () => {
		expect.assertions(1);

		const files = ["src/a.spec.ts", "src/legacy/b.spec.ts", "src/gen/c.spec.ts"];

		expect(applyExcludes(files, ["**/legacy/**", "**/gen/**"])).toStrictEqual([
			"src/a.spec.ts",
		]);
	});
});
