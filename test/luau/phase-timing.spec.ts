import { describe, expect, it } from "vitest";

import {
	fillPlaceholders,
	readHarness,
	readLuauModule,
	spawnHarness,
} from "#test/luau/lute-harness.ts";
import { LUTE_HARNESS_TIMEOUT } from "#test/luau/lute-timeout.ts";

// Drives the shared `runner.timing` envelope builder under lute. Pure module, no
// dependencies to inline. Requires `lute` on PATH (mise, in dev and CI).
const MODULE_SOURCE = readLuauModule("phase-timing.luau");
const HARNESS = readHarness("phase-timing");

describe("shared phase-timing builder under lute", { timeout: LUTE_HARNESS_TIMEOUT }, () => {
	it("should pass the phase-timing harness assertions", () => {
		expect.assertions(1);

		const script = fillPlaceholders(HARNESS, { __MODULE__: MODULE_SOURCE });

		expect(spawnHarness("phase-timing-", script)).toContain("ALL OK");
	});
});
