import { describe, expect, it } from "vitest";

import {
	fillPlaceholders,
	readHarness,
	readLuauTree,
	spawnHarness,
	stubbedModules,
} from "#test/luau/lute-harness.ts";

// Drives the workspace bail signal under lute. Pure module over an injected
// SortedMap, so nothing Roblox-side has to be stubbed. Requires `lute` on PATH
// (mise, in dev and CI).
const HARNESS = readHarness("bail");
const STUBBED = stubbedModules(HARNESS);
const MODULE_SOURCE = readLuauTree("staging/bail.luau", STUBBED);

describe("workspace bail signal under lute", () => {
	it("should pass the bail harness assertions", () => {
		expect.assertions(1);

		const script = fillPlaceholders(HARNESS, { __MODULE__: MODULE_SOURCE });

		expect(spawnHarness("bail-", script)).toContain("ALL OK");
	});
});
