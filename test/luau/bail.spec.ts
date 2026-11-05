import { describe, expect, it } from "vitest";

import {
	fillPlaceholders,
	readHarness,
	readLuauModule,
	spawnHarness,
} from "#test/luau/lute-harness.ts";
import { LUTE_HARNESS_TIMEOUT } from "#test/luau/lute-timeout.ts";

// Drives the workspace bail signal under lute. Pure module over an injected
// SortedMap, so nothing Roblox-side has to be stubbed. Requires `lute` on PATH
// (mise, in dev and CI).
const MODULE_SOURCE = readLuauModule("staging/bail.luau");
const HARNESS = readHarness("bail");

describe("workspace bail signal under lute", { timeout: LUTE_HARNESS_TIMEOUT }, () => {
	it("should pass the bail harness assertions", () => {
		expect.assertions(1);

		const script = fillPlaceholders(HARNESS, { __MODULE__: MODULE_SOURCE });

		expect(spawnHarness("bail-", script)).toContain("ALL OK");
	});
});
