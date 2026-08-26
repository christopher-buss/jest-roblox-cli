import { describe, expect, it } from "vitest";

import { isTsSource, stripTsExtension } from "./extensions.ts";

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

	it("should only strip a known extension at the end", () => {
		expect.assertions(1);

		expect(stripTsExtension("src/module.ts.map")).toBe("src/module.ts.map");
	});
});

describe(isTsSource, () => {
	it("should distinguish TypeScript sources from paths that merely contain the extension", () => {
		expect.assertions(3);

		expect(isTsSource("src/module.ts")).toBeTrue();
		expect(isTsSource("src/view.tsx")).toBeTrue();
		expect(isTsSource("src/module.ts.map")).toBeFalse();
	});
});
