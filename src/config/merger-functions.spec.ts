import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import { isAgent } from "std-env";
import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { Config } from "./config-types.ts";
import { resolveFunctionValues } from "./merger-functions.ts";
import type { ResolvedConfig } from "./resolved-config.ts";

const TERMINAL_DEFAULT = isAgent ? "agent" : "default";

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

	it("should extend the resolved Luau roots instead of an empty array", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		expect(
			resolveFunctionValues(
				{
					luauRoots: (defaults: Array<string>) => {
						return [...defaults, "extra"];
					},
				},
				{
					fileSystem,
					tsconfigReader: () => {
						return {
							config: { compilerOptions: { outDir: "out" } },
							path: "tsconfig.json",
						};
					},
				},
			),
		).toStrictEqual({ luauRoots: ["out", "extra"] });
	});

	it.for<Pick<Config, "rojoProject">>([{ rojoProject: "test.project.json" }, {}])(
		"should resolve Rojo project %j in the configured root and honor test ignores",
		(rojoConfig) => {
			expect.assertions(1);

			const rootDirectory = path.resolve("/repo/pkg");
			const { fileSystem } = createMemoryFileSystem({
				[path.join(rootDirectory, "code/init.luau")]: "return {}",
				[path.join(rootDirectory, "ignored/init.luau")]: "return {}",
				[path.join(rootDirectory, "test.project.json")]: JSON.stringify({
					name: "pkg",
					tree: {
						$className: "DataModel",
						ReplicatedStorage: {
							Code: { $path: "code" },
							Ignored: { $path: "ignored" },
						},
					},
				}),
			});

			expect(
				resolveFunctionValues(
					{
						luauRoots: (defaults) => defaults,
						...rojoConfig,
						test: { coveragePathIgnorePatterns: ["ignored"] },
					},
					{ fileSystem, rootDirectory },
				),
			).toMatchObject({ luauRoots: ["code"] });
		},
	);

	it("should preserve explicit roots without resolving defaults", () => {
		expect.assertions(1);

		expect(resolveFunctionValues({ luauRoots: ["custom"] })).toStrictEqual({
			luauRoots: ["custom"],
		});
	});

	it("should resolve a root merger function when no test block is present", () => {
		expect.assertions(1);

		const layer: Config = fromAny({
			formatters: (defaults: Array<string>) => {
				return [...defaults, "json"];
			},
		});

		expect(resolveFunctionValues(layer)).toStrictEqual({
			formatters: [TERMINAL_DEFAULT, "json"],
		});
	});
});
