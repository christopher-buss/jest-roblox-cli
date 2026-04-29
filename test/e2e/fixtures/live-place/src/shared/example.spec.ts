import { describe, expect, it } from "@rbxts/jest-globals";

import { add } from "./example";

describe("shared example", () => {
	it("adds two numbers", () => {
		expect(add(2, 3)).toBe(5);
	});
});
