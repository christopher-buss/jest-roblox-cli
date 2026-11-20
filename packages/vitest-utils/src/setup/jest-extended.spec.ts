import { describe, it } from "vitest";

import { registerJestExtended } from "./jest-extended.ts";

describe(registerJestExtended, () => {
	it("should make the jest-extended matchers available", ({ expect }) => {
		expect.assertions(2);

		registerJestExtended();

		expect([1, 2]).toBeArrayOfSize(2);
		expect("vitest").toStartWith("vi");
	});
});
