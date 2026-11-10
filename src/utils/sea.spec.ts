import { describe, expect, it, vi } from "vitest";

import { isSeaBuild, markSeaBuild } from "./sea.ts";

describe(isSeaBuild, () => {
	it.for([
		[undefined, false],
		["false", false],
		["true", true],
	] as const)("should read JEST_ROBLOX_SEA=%s as %s", ([value, expected]) => {
		expect.assertions(1);

		vi.stubEnv("JEST_ROBLOX_SEA", value);

		expect(isSeaBuild()).toBe(expected);
	});
});

describe(markSeaBuild, () => {
	it("should make the process read as the SEA build", () => {
		expect.assertions(1);

		vi.stubEnv("JEST_ROBLOX_SEA", undefined);
		markSeaBuild();

		expect(isSeaBuild()).toBeTrue();
	});
});
