import { describe, expectTypeOf, it } from "vitest";

import type { Config, ConfigInput, ResolvedConfig } from "./index.ts";
import * as source from "./index.ts";
import { defineConfig, defineProject } from "./index.ts";

describe("package root entry types", () => {
	it("should type a config file's default export through defineConfig", () => {
		expectTypeOf(defineConfig).parameter(0).toEqualTypeOf<ConfigInput>();
		expectTypeOf(defineConfig).returns.toEqualTypeOf<ConfigInput>();
	});

	it("should resolve the user's place file to a required one", () => {
		expectTypeOf<Config["placeFile"]>().toExtend<string | undefined>();
		expectTypeOf<ResolvedConfig["placeFile"]>().toBeString();
	});

	it("should expose defineProject for per-project config files", () => {
		expectTypeOf(defineProject).toBeFunction();
	});

	it("should keep the config key table private", () => {
		expectTypeOf(source).not.toHaveProperty("KEY_LOCATIONS");
	});
});
