import { describe, expect, it } from "vitest";

import type { TsconfigMapping } from "../types/tsconfig.ts";
import { findMapping, replacePrefix } from "./tsconfig-mapping.ts";

describe(findMapping, () => {
	const mappings: Array<TsconfigMapping> = [
		{ outDir: "out", rootDir: "src" },
		{ outDir: "out-test", rootDir: "." },
	];

	it("should match by outDir prefix", () => {
		expect.assertions(1);

		expect(findMapping("out/shared/foo", mappings)).toStrictEqual({
			outDir: "out",
			rootDir: "src",
		});
	});

	it("should match longest outDir prefix", () => {
		expect.assertions(1);

		expect(
			findMapping("out/shared/actions/define.spec", [
				{ outDir: "out/shared", rootDir: "shared" },
				{ outDir: "out", rootDir: "src" },
			]),
		).toStrictEqual({ outDir: "out/shared", rootDir: "shared" });
	});

	it("should keep the first mapping when matching prefixes have equal length", () => {
		expect.assertions(1);

		expect(
			findMapping("out/shared/foo", [
				{ outDir: "out", rootDir: "first" },
				{ outDir: "out", rootDir: "second" },
			]),
		).toStrictEqual({ outDir: "out", rootDir: "first" });
	});

	it("should not match partial prefix without boundary", () => {
		expect.assertions(1);

		expect(findMapping("output/foo", mappings)).toBeUndefined();
	});

	it("should match exact outDir", () => {
		expect.assertions(1);

		expect(findMapping("out", mappings)).toStrictEqual({
			outDir: "out",
			rootDir: "src",
		});
	});

	it("should return undefined for no match", () => {
		expect.assertions(1);

		expect(findMapping("lib/foo", mappings)).toBeUndefined();
	});

	it("should return undefined for empty mappings", () => {
		expect.assertions(1);

		expect(findMapping("out/foo", [])).toBeUndefined();
	});

	it("should match by rootDir when key is rootDir", () => {
		expect.assertions(1);

		expect(findMapping("src/shared/foo", mappings, "rootDir")).toStrictEqual({
			outDir: "out",
			rootDir: "src",
		});
	});

	it("should match rootDir dot for paths starting with dot-slash", () => {
		expect.assertions(1);

		expect(findMapping("./test/foo", mappings, "rootDir")).toStrictEqual({
			outDir: "out-test",
			rootDir: ".",
		});
	});
});

describe(replacePrefix, () => {
	it("should replace prefix with slash boundary", () => {
		expect.assertions(1);

		expect(replacePrefix("out/shared/foo", "out", "src")).toBe("src/shared/foo");
	});

	it("should replace exact match", () => {
		expect.assertions(1);

		expect(replacePrefix("out", "out", "src")).toBe("src");
	});

	it("should return unchanged when no match", () => {
		expect.assertions(1);

		expect(replacePrefix("other/foo", "out", "src")).toBe("other/foo");
	});

	it("should not replace partial prefix", () => {
		expect.assertions(1);

		expect(replacePrefix("output/foo", "out", "src")).toBe("output/foo");
	});

	it("should prepend target when replacing the '.' root prefix", () => {
		expect.assertions(1);

		// A `rootDirs` tsconfig collapses rootDir to ".". The resolver strips the
		// leading "./" from filePaths, so the inverse "." → outDir mapping must
		// still match a bare relative path and prepend the outDir.
		expect(replacePrefix("src/server/foo.luau", ".", "out-test")).toBe(
			"out-test/src/server/foo.luau",
		);
	});

	it("should prepend target when replacing '.' for a dot-slash path", () => {
		expect.assertions(1);

		expect(replacePrefix("./src/server/foo.luau", ".", "out-test")).toBe(
			"out-test/src/server/foo.luau",
		);
	});
});
