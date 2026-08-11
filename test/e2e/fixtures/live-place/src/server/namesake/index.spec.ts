import { describe, expect, it } from "@rbxts/jest-globals";

// Paired with `../other/index.spec.ts`: both compile to an Instance named
// `init.spec`, so a run narrowed to this file proves the forwarded pattern
// carries path context rather than a bare basename.
describe("namesake spec", () => {
	it("runs when narrowed to its own path", () => {
		expect(1 + 1).toBe(2);
	});
});
