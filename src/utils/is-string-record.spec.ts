import { describe, expect, it } from "vitest";

import { isStringRecord } from "./is-string-record.ts";

describe(isStringRecord, () => {
	it("should reject null", () => {
		expect.assertions(1);
		expect(isStringRecord(null)).toBeFalse();
	});

	it("should reject primitives", () => {
		expect.assertions(3);
		expect(isStringRecord("string")).toBeFalse();
		expect(isStringRecord(42)).toBeFalse();
		expect(isStringRecord(true)).toBeFalse();
	});

	it("should reject arrays", () => {
		expect.assertions(1);
		expect(isStringRecord(["a", "b"])).toBeFalse();
	});

	it("should reject objects with symbol-keyed properties", () => {
		expect.assertions(1);

		const sym = Symbol("k");

		expect(isStringRecord({ [sym]: "value" })).toBeFalse();
	});

	it("should reject objects with non-string values", () => {
		expect.assertions(1);
		expect(isStringRecord({ key: 42 })).toBeFalse();
	});

	it("should accept empty objects", () => {
		expect.assertions(1);
		expect(isStringRecord({})).toBeTrue();
	});

	it("should accept objects with all-string values", () => {
		expect.assertions(1);
		expect(isStringRecord({ a: "1", b: "2" })).toBeTrue();
	});
});
