import { describe, expect, it } from "vitest";

import { deriveTypecheckInclude } from "./derive-typecheck-include.ts";

describe(deriveTypecheckInclude, () => {
	it.for([
		[["**/*.spec.ts"], ["**/*.spec-d.ts"]],
		[["**/*.test.ts"], ["**/*.test-d.ts"]],
		[["out/a/*.spec.ts"], ["out/a/*.spec-d.ts"]],
		[
			["out/**/*.spec.ts", "out/**/*.test.ts"],
			["out/**/*.spec-d.ts", "out/**/*.test-d.ts"],
		],
		[["**/*.spec.tsx"], []],
		[["**/*.spec.luau"], []],
		[["**/*.test.lua"], []],
		[["**/*.ts"], []],
		[["**/*.spec-d.ts"], []],
		[["src/spec.helpers/*.spec.ts"], ["src/spec.helpers/*.spec-d.ts"]],
		[[], []],
	] as const)("should derive %o into %o", ([input, expected]) => {
		expect.assertions(1);

		expect(deriveTypecheckInclude(input)).toStrictEqual(expected);
	});
});
