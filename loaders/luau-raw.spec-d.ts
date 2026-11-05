import { describe, expectTypeOf, it } from "vitest";

import { load, resolve } from "./luau-raw.mjs";

describe("loader entry point types", () => {
	it("should implement the Node resolve hook", () => {
		expectTypeOf(resolve).parameter(0).toBeString();
		expectTypeOf(resolve).returns.toHaveProperty("url").toBeString();
	});

	it("should implement the Node load hook", () => {
		expectTypeOf(load).parameter(0).toBeString();
		expectTypeOf(load).returns.toHaveProperty("source").toBeString();
		expectTypeOf(load).returns.toHaveProperty("format").toBeString();
	});
});
