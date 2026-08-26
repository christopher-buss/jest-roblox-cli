import { describe, expect, it } from "vitest";

import { omitUndefined } from "./omit-undefined.ts";

describe(omitUndefined, () => {
	it("should omit only properties whose value is undefined", () => {
		expect.assertions(2);

		const input = { empty: "", falseValue: false, missing: undefined, zero: 0 };

		expect(omitUndefined(input)).toStrictEqual({ empty: "", falseValue: false, zero: 0 });
		expect(input).toHaveProperty("missing");
	});
});
