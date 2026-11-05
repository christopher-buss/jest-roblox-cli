import { describe, expect, it } from "vitest";

import {
	fillPlaceholders,
	readHarness,
	readLuauModule,
	spawnHarness,
} from "#test/luau/lute-harness.ts";
import { LUTE_HARNESS_TIMEOUT } from "#test/luau/lute-timeout.ts";

// Drives the workspace return-envelope budget under lute. Pure module, no
// dependencies to inline. Requires `lute` on PATH (mise, in dev and CI).
const MODULE_SOURCE = readLuauModule("staging/result-budget.luau");
const HARNESS = readHarness("result-budget");

describe("workspace result budget under lute", { timeout: LUTE_HARNESS_TIMEOUT }, () => {
	it("should pass the result-budget harness assertions", () => {
		expect.assertions(1);

		const script = fillPlaceholders(HARNESS, { __MODULE__: MODULE_SOURCE });

		expect(spawnHarness("result-budget-", script)).toContain("ALL OK");
	});
});
