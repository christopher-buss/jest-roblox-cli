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

		expect(findMapping("out-test/src/actions/define.spec", mappings)).toStrictEqual({
			outDir: "out-test",
			rootDir: ".",
		});
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
});
