import { describe, expect, it } from "vitest";

import { isString } from "./is-string.ts";

describe(isString, () => {
	it("should accept a string", () => {
		expect.assertions(1);

		expect(isString("value")).toBeTrue();
	});

	it("should reject non-strings", () => {
		expect.assertions(4);

		expect(isString(42)).toBeFalse();
		expect(isString(undefined)).toBeFalse();
		expect(isString(null)).toBeFalse();
		expect(isString(["value"])).toBeFalse();
	});
});
