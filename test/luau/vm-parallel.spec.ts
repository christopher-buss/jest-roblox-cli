import { describe, expect, it } from "vitest";

import {
	fillPlaceholders,
	readHarness,
	readLuauModule,
	spawnHarness,
} from "#test/luau/lute-harness.ts";
import { LUTE_HARNESS_TIMEOUT } from "#test/luau/lute-timeout.ts";

// Drives the coordinator's slice planner and gather under lute. Pure module, no
// dependencies to inline. Requires `lute` on PATH (mise, in dev and CI).
const MODULE_SOURCE = readLuauModule("vm-parallel.luau");
const HARNESS = readHarness("vm-parallel");

describe("vm-parallel dispatch planning under lute", { timeout: LUTE_HARNESS_TIMEOUT }, () => {
	it("should pass the vm-parallel harness assertions", () => {
		expect.assertions(1);

		const script = fillPlaceholders(HARNESS, { __MODULE__: MODULE_SOURCE });

		expect(spawnHarness("vm-parallel-", script)).toContain("ALL OK");
	});
});
