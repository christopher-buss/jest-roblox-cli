import { describe, it } from "vitest";

import { createResolvedConfig } from "#test/helpers/unit/resolved-config.ts";
import { pickCoverageSettings } from "./coverage-settings.ts";

describe(pickCoverageSettings, () => {
	it("should carry the resolved values, defaults included", ({ expect }) => {
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
