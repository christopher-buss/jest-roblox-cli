import { describe, expect, it } from "vitest";

import {
	fillPlaceholders,
	readHarness,
	readLuauModule,
	spawnHarness,
} from "#test/luau/lute-harness.ts";
import { LUTE_HARNESS_TIMEOUT } from "#test/luau/lute-timeout.ts";

// Drives the workspace materializer under lute against a fake DataModel the
// harness supplies. Requires `lute` on PATH (mise, in dev and CI).
const MODULE_SOURCE = readLuauModule("staging/materializer.luau");
const HARNESS = readHarness("materializer");

describe("workspace materializer under lute", { timeout: LUTE_HARNESS_TIMEOUT }, () => {
	it("should pass the materializer harness assertions", () => {
		expect.assertions(1);

		const script = fillPlaceholders(HARNESS, { __MODULE__: MODULE_SOURCE });

		expect(spawnHarness("materializer-", script)).toContain("ALL OK");
	});
});
