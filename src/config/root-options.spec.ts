import { describe, expect, it } from "vitest";

import { ROOT_ROWS } from "./root-options.ts";

describe("root options", () => {
	it("should place every row at the root", () => {
		expect.assertions(1);

		expect(ROOT_ROWS.filter(({ location }) => location !== "root")).toStrictEqual([]);
	});

	it("should keep root keys from Jest", () => {
		expect.assertions(1);

		expect(ROOT_ROWS.filter(({ jest }) => jest === true)).toStrictEqual([]);
	});
});
