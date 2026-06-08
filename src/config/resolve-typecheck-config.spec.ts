import { describe, expect, it } from "vitest";

import type { ResolvedTypecheckConfig, TypecheckLayers } from "./resolve-typecheck-config.ts";
import { resolveTypecheckConfig } from "./resolve-typecheck-config.ts";

const cases: Array<[TypecheckLayers, ResolvedTypecheckConfig]> = [
	[{}, { enabled: false, only: false }],
	[{ cli: { only: true } }, { enabled: true, only: true }],
	[{ project: { only: true } }, { enabled: true, only: true }],
	[{ root: { only: true } }, { enabled: true, only: true }],
	[{ cli: { enabled: true } }, { enabled: true, only: false }],
	[{ project: { enabled: true } }, { enabled: true, only: false }],
	[{ root: { enabled: true } }, { enabled: true, only: false }],
	[
		{ cli: { enabled: false }, project: { enabled: true } },
		{ enabled: false, only: false },
	],
	[
		{ project: { include: ["a"] }, root: { include: ["b"] } },
		{ enabled: false, include: ["a"], only: false },
	],
	[{ root: { include: ["b"] } }, { enabled: false, include: ["b"], only: false }],
	[
		{ project: { exclude: ["x"] }, root: { exclude: ["y"] } },
		{ enabled: false, exclude: ["x"], only: false },
	],
	[{ root: { exclude: ["y"] } }, { enabled: false, exclude: ["y"], only: false }],
	[
		{ cli: { tsconfig: "c" }, project: { tsconfig: "p" }, root: { tsconfig: "r" } },
		{ enabled: false, only: false, tsconfig: "c" },
	],
	[
		{ project: { tsconfig: "p" }, root: { tsconfig: "r" } },
		{ enabled: false, only: false, tsconfig: "p" },
	],
	[{ root: { tsconfig: "r" } }, { enabled: false, only: false, tsconfig: "r" }],
	[
		{ project: { ignoreSourceErrors: true }, root: { ignoreSourceErrors: false } },
		{ enabled: false, ignoreSourceErrors: true, only: false },
	],
	[
		{ root: { ignoreSourceErrors: true } },
		{ enabled: false, ignoreSourceErrors: true, only: false },
	],
	[
		{ project: { spawnTimeout: 5000 }, root: { spawnTimeout: 3000 } },
		{ enabled: false, only: false, spawnTimeout: 5000 },
	],
	[{ root: { spawnTimeout: 3000 } }, { enabled: false, only: false, spawnTimeout: 3000 }],
];

describe(resolveTypecheckConfig, () => {
	it.for(cases)("should merge layers (case %#)", ([layers, expected]) => {
		expect.assertions(1);

		expect(resolveTypecheckConfig(layers)).toStrictEqual(expected);
	});
});
