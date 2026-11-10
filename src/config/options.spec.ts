import { describe, expect, it } from "vitest";

import type { OptionRow } from "./option-row.ts";
import { isTestKey, JEST_ARGV_KEYS, OPTION_ROWS, STUB_KEYS } from "./options.ts";

function spellings({ cli }: OptionRow): Array<string> {
	if (cli === undefined) {
		return [];
	}

	return cli.negation === undefined ? [cli.name] : [cli.name, cli.negation.name];
}

describe("option registry", () => {
	it("should give every flag spelling to one option", () => {
		expect.assertions(1);

		const names = OPTION_ROWS.flatMap(spellings);

		const unique = new Set(names);

		expect(unique.size).toBe(names.length);
	});

	it.for(["testTimeout", "displayName", "testNamePattern"])(
		"should forward %s to Jest",
		(key) => {
			expect.assertions(1);

			expect(JEST_ARGV_KEYS.has(key)).toBeTrue();
		},
	);

	it.for(["backend", "collectCoverage", "coverage", "projectTimeout", "typecheck"])(
		"should keep %s from Jest",
		(key) => {
			expect.assertions(1);

			expect(JEST_ARGV_KEYS.has(key)).toBeFalse();
		},
	);

	it.for(["outDir", "root", "typecheck", "projectTimeout", "verbose"])(
		"should keep %s out of runtime stubs",
		(key) => {
			expect.assertions(1);

			expect(STUB_KEYS.has(key)).toBeFalse();
		},
	);

	it("should put setupFiles in runtime stubs", () => {
		expect.assertions(1);

		expect(STUB_KEYS.has("setupFiles")).toBeTrue();
	});

	it("should place jest options under test", () => {
		expect.assertions(3);

		expect(isTestKey("verbose")).toBeTrue();
		expect(isTestKey("backend")).toBeFalse();
		expect(isTestKey("root")).toBeFalse();
	});
});
