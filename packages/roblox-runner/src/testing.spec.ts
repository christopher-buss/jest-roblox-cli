import { describe, expect, it } from "vitest";

import { formatPlaceMismatch, PLACE_MISMATCH } from "./testing.ts";

describe(formatPlaceMismatch, () => {
	it("should expose the fake-task refusal wire format", () => {
		expect.assertions(2);

		expect(PLACE_MISMATCH).toBe("ROBLOX_RUNNER_PLACE_MISMATCH");
		expect(formatPlaceMismatch(17)).toBe("ROBLOX_RUNNER_PLACE_MISMATCH:17");
	});
});
