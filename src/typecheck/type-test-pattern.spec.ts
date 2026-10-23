import { describe, expect, it } from "vitest";

import { TYPE_TEST_PATTERN } from "./type-test-pattern.ts";

describe("tYPE_TEST_PATTERN", () => {
	it.for([
		["foo.test-d.ts", true],
		["foo.spec-d.ts", true],
		["foo.test.ts", false],
		["foo.spec.ts", false],
		["foo.spec-d.tsx", false],
	] as const)("should match %s = %s", ([file, expected]) => {
		expect.assertions(1);

		expect(TYPE_TEST_PATTERN.test(file)).toBe(expected);
	});
});
