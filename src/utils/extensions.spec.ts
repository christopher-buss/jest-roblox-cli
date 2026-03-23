import { describe, expect, it } from "vitest";

import { stripTsExtension } from "./extensions.ts";

describe(stripTsExtension, () => {
	it("should strip .ts extension", () => {
		expect.assertions(1);

		expect(stripTsExtension("**/*.spec.ts")).toBe("**/*.spec");
	});

	it("should strip .tsx extension", () => {
		expect.assertions(1);

		expect(stripTsExtension("**/*.test.tsx")).toBe("**/*.test");
	});

	it("should strip .luau extension", () => {
		expect.assertions(1);

		expect(stripTsExtension("**/*.spec.luau")).toBe("**/*.spec");
	});

	it("should not change pattern without known extension", () => {
		expect.assertions(1);

		expect(stripTsExtension("**/*.spec")).toBe("**/*.spec");
	});
});
