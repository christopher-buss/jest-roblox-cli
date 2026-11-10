import { describe, expect, it } from "vitest";

import {
	fillPlaceholders,
	readHarness,
	readLuauTree,
	spawnHarness,
	stubbedModules,
} from "#test/luau/lute-harness.ts";

// Drives the shared infinite-yield watchdog under lute. Its only engine
// dependency is LogService, which the harness fakes. Requires `lute` on PATH
// (mise, in dev and CI).
const HARNESS = readHarness("infinite-yield");
const STUBBED = stubbedModules(HARNESS);
const MODULE_SOURCE = readLuauTree("infinite-yield.luau", STUBBED);

describe("infinite-yield watchdog under lute", () => {
	it("should pass the infinite-yield harness assertions", () => {
		expect.assertions(1);

		const script = fillPlaceholders(HARNESS, { __MODULE__: MODULE_SOURCE });

		expect(spawnHarness("infinite-yield-", script)).toContain("ALL OK");
	});
});
