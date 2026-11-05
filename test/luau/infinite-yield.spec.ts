import { describe, expect, it } from "vitest";

import {
	fillPlaceholders,
	readHarness,
	readLuauModule,
	spawnHarness,
} from "#test/luau/lute-harness.ts";
import { LUTE_HARNESS_TIMEOUT } from "#test/luau/lute-timeout.ts";

// Drives the shared infinite-yield watchdog under lute. Its only dependency is
// LogService, which the harness fakes. Requires `lute` on PATH (mise, in dev
// and CI).
const MODULE_SOURCE = readLuauModule("infinite-yield.luau");
const HARNESS = readHarness("infinite-yield");

describe("infinite-yield watchdog under lute", { timeout: LUTE_HARNESS_TIMEOUT }, () => {
	it("should pass the infinite-yield harness assertions", () => {
		expect.assertions(1);

		const script = fillPlaceholders(HARNESS, { __MODULE__: MODULE_SOURCE });

		expect(spawnHarness("infinite-yield-", script)).toContain("ALL OK");
	});
});
