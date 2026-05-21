import { describe, expect, it } from "@rbxts/jest-globals";

import { add } from "./example";

describe("shared example", () => {
	it("adds two numbers", () => {
		// HAL-225 game-output regression marker. Asserted by the live e2e in
		// project-pipeline.e2e.spec.ts — native `warn` must land in the
		// `--gameOutput` JSON dump (LogService capture path).
		warn("HAL-225 game-output marker");
		expect(add(2, 3)).toBe(5);
	});
});
