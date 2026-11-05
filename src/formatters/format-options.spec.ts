import { describe, expect, it } from "vitest";

import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import { toFormatOptions } from "./format-options.ts";

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return {
		...createResolvedConfig(),
		rootDir: "/repo",
		testMatch: ["**/*.spec.ts"],
		testPathIgnorePatterns: [],
		...overrides,
	};
}

describe(toFormatOptions, () => {
	it("should copy the render fields from the config and add the version", () => {
		expect.assertions(1);

		const config = makeConfig({
			collectCoverage: true,
			color: false,
			showLuau: true,
			slowTestThreshold: 250,
			verbose: true,
		});

		expect(toFormatOptions(config, "2.0.0")).toStrictEqual({
			collectCoverage: true,
			color: false,
			rootDir: "/repo",
			showLuau: true,
			slowTestThreshold: 250,
			verbose: true,
			version: "2.0.0",
		});
	});
});
