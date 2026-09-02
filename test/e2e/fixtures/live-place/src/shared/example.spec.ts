import { describe, expect, it } from "@rbxts/jest-globals";

import { add, sign, subtract } from "./example";

// The three call shapes whose call site the runtime reads differently: a bare
// `it`, one inside a `describe`, and an `it.each` table. The live e2e in
// test/e2e/live/pipeline.e2e.spec.ts asserts each one's recorded location is
// its own `it(` line in this file. Each test covers a statement no other test
// reaches, because attribution records a test only for statements it covered
// first.
it("subtracts at the top level", () => {
	expect(subtract(3, 1)).toBe(2);
});

describe("shared example", () => {
	it("adds two numbers", () => {
		// Game-output regression marker. Asserted by the live e2e in
		// test/e2e/live/pipeline.e2e.spec.ts — native `warn` must land in
		// the `--gameOutput` JSON dump (LogService capture path).
		warn("game-output marker");
		expect(add(2, 3)).toBe(5);
	});

	// One `%s` only: jest-roblox fills mixed `%i`/`%s` placeholders out of order.
	it.each(["negative", "positive"])("signs a %s number", (kind) => {
		expect(sign(kind === "negative" ? -1 : 1)).toBe(kind);
	});
});
