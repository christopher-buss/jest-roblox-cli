import { describe, expect, it } from "@rbxts/jest-globals";

import { multiply } from "./server-thing";

describe("server thing", () => {
	it("multiplies two numbers", () => {
		expect(multiply(3, 4)).toBe(12);
	});
});
