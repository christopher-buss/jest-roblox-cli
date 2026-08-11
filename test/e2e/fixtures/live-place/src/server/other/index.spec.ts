import { describe, expect, it } from "@rbxts/jest-globals";

// The namesake of `../namesake/index.spec.ts`. A run narrowed to that file must
// leave this one out.
describe("other namesake spec", () => {
	it("stays out of a run narrowed to its namesake", () => {
		expect(2 + 2).toBe(4);
	});
});
