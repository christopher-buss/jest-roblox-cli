import { describe, expect, it } from "vitest";

import {
	fillPlaceholders,
	readHarness,
	readLuauTree,
	spawnHarness,
	stubbedModules,
} from "#test/luau/lute-harness.ts";

// Drives the workspace return-envelope budget under lute. Pure module, no
// dependencies to inline. Requires `lute` on PATH (mise, in dev and CI).
const HARNESS = readHarness("result-budget");
const STUBBED = stubbedModules(HARNESS);
const MODULE_SOURCE = readLuauTree("staging/result-budget.luau", STUBBED);

describe("workspace result budget under lute", () => {
	it("should pass the result-budget harness assertions", () => {
		expect.assertions(1);

		const script = fillPlaceholders(HARNESS, { __MODULE__: MODULE_SOURCE });

		expect(spawnHarness("result-budget-", script)).toContain("ALL OK");
	});
});
