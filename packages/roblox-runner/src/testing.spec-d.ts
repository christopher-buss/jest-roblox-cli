import { describe, expectTypeOf, it } from "vitest";

import { formatPlaceMismatch, PLACE_MISMATCH } from "./testing.ts";

describe("testing entry point types", () => {
	it("should expose the fake-task wire format", () => {
		expectTypeOf(formatPlaceMismatch).toEqualTypeOf<(bootedVersion: number) => string>();
		expectTypeOf(PLACE_MISMATCH).toEqualTypeOf<string>();
	});
});
