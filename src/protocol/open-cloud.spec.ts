import { describe, it } from "vitest";

import { BOOT_PROBE_SCRIPT } from "./open-cloud.ts";

describe("bOOT_PROBE_SCRIPT", () => {
	it("should return the place version the server booted", ({ expect }) => {
		expect.assertions(1);

		expect(BOOT_PROBE_SCRIPT).toBe("return tostring(game.PlaceVersion)");
	});
});
