import { describe, expect, it } from "vitest";

import { NESTED_PINNED_CLASSES } from "./staged-place.ts";

describe("nESTED_PINNED_CLASSES", () => {
	it("should pin each nested singleton under one service", () => {
		expect.assertions(1);

		const names = Object.values(NESTED_PINNED_CLASSES).flat();
		const unique = new Set(names);

		expect(unique.size).toBe(names.length);
	});
});
