import { describe, expect, it } from "@rbxts/jest-globals";

// Sits at `nested/namesake`, so the path of `../../namesake/index.spec.ts` is a
// bare suffix of this one's. A run narrowed to that file must leave this out,
// which only holds while the forwarded pattern carries the mount's own name.
describe("nested namesake spec", () => {
	it("stays out of a run narrowed to the shallower namesake", () => {
		expect(3 + 3).toBe(6);
	});
});
