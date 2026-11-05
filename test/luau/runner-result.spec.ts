import { describe, expect, it } from "vitest";

import {
	fillPlaceholders,
	readHarness,
	readLuauModule,
	spawnHarness,
} from "#test/luau/lute-harness.ts";
import { LUTE_HARNESS_TIMEOUT } from "#test/luau/lute-timeout.ts";

// Drives the shared runner-result builder under lute. Its instance-resolver and
// per-test-coverage dependencies are stubbed by the harness, which the module
// picks up by being inlined into it. Requires `lute` on PATH (mise, in dev and
// CI).
const MODULE_SOURCE = readLuauModule("runner-result.luau");
const HARNESS = readHarness("runner-result");

describe("shared runner-result builder under lute", { timeout: LUTE_HARNESS_TIMEOUT }, () => {
	it("should pass the runner-result harness assertions", () => {
		expect.assertions(1);

		const script = fillPlaceholders(HARNESS, { __MODULE__: MODULE_SOURCE });

		expect(spawnHarness("runner-result-", script)).toContain("ALL OK");
	});
});
