import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "#src/index.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";

describe("unit test doubles", () => {
	it("should keep the resolved config fixture equal to the shipped defaults", () => {
		expect.assertions(1);

		expect(createResolvedConfig()).toStrictEqual(DEFAULT_CONFIG);
	});
});
