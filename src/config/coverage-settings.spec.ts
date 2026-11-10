import { describe, expect, it } from "vitest";

import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import { pickCoverageSettings } from "./coverage-settings.ts";

describe(pickCoverageSettings, () => {
	it("should carry the resolved values, defaults included", () => {
		expect.assertions(1);

		const config = createResolvedConfig({
			collectCoverageFrom: ["src/**"],
			coverageCache: false,
			rootDir: "/repo/pkg",
		});

		expect(pickCoverageSettings(config)).toStrictEqual({
			collectCoverageFrom: ["src/**"],
			coverageCache: false,
			coverageCopyIgnorePatterns: config.coverageCopyIgnorePatterns,
			coveragePathIgnorePatterns: config.coveragePathIgnorePatterns,
			rootDir: "/repo/pkg",
		});
	});
});
