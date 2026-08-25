import { describe, expect, it } from "@rbxts/jest-globals";

import { add } from "./example";

describe("shared example", () => {
	it("adds two numbers", () => {
		// Game-output regression marker. Asserted by the live e2e in
		// test/e2e/live/pipeline.e2e.spec.ts — native `warn` must land in
		// the `--gameOutput` JSON dump (LogService capture path).
		warn("game-output marker");
		expect(add(2, 3)).toBe(5);
	});
});
