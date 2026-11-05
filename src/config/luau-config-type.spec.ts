import { describe, expect, it } from "vitest";

import { LUAU_CONFIG_TYPE_SOURCE } from "./luau-config-type.ts";

describe("lUAU_CONFIG_TYPE_SOURCE", () => {
	it("should hold the Luau Config type", () => {
		expect.assertions(1);

		expect(LUAU_CONFIG_TYPE_SOURCE).toContain("export type Config =");
	});
});
