import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it } from "vitest";

import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import { resolveFunctionValues } from "./merger-functions.ts";
import type { Config, ResolvedConfig } from "./schema.ts";

describe(resolveFunctionValues, () => {
	it("should resolve merger functions against defaults", () => {
		expect.assertions(1);

		const layer: Config = fromAny({
			test: {
				coveragePathIgnorePatterns: () => ["ignored"],
				coverageThreshold: (defaults: NonNullable<ResolvedConfig["coverageThreshold"]>) => {
					return { ...defaults, lines: 80 };
				},
				reporters: () => ["default"],
				roots: () => ["custom-root"],
				setupFiles: (defaults: Array<string>) => {
					return [...defaults, "setup.luau"];
				},
				snapshotFormat: (defaults: NonNullable<ResolvedConfig["snapshotFormat"]>) => {
					return { ...defaults, printBasicPrototype: false };
				},
				testMatch: (defaults: Array<string>) => {
					return [...defaults, "**/*.test.ts"];
				},
			},
		});

		expect(resolveFunctionValues(layer)).toMatchObject({
			test: {
				coveragePathIgnorePatterns: ["ignored"],
				coverageThreshold: { lines: 80 },
				reporters: ["default"],
				roots: ["custom-root"],
				setupFiles: ["setup.luau"],
				snapshotFormat: { printBasicPrototype: false },
				testMatch: expect.arrayContaining(["**/*.test.ts"]),
			},
		});
	});

	it("should hand array mergers a copy of the default and object mergers an empty object", () => {
		expect.assertions(1);

		const layer: Config = fromAny({
			coverageThreshold: (defaults: unknown) => defaults,
			testMatch: (defaults: Array<string>) => defaults,
		});

		expect(resolveFunctionValues(layer)).toStrictEqual({
			coverageThreshold: {},
			testMatch: createResolvedConfig().testMatch,
		});
	});

	it("should resolve a root merger function when no test block is present", () => {
		expect.assertions(1);

		const layer: Config = fromAny({
			formatters: (defaults: Array<string>) => {
				return [...defaults, "json"];
			},
		});

		expect(resolveFunctionValues(layer)).toStrictEqual({ formatters: ["json"] });
	});
});
