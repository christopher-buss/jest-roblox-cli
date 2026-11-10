import { describe, expect, it } from "vitest";

import {
	fillPlaceholders,
	readHarness,
	readLuauTree,
	spawnHarness,
	stubbedModules,
} from "#test/luau/lute-harness.ts";

// Drives the shared runner-result builder under lute. Its instance-resolver and
// per-test-coverage dependencies are stubbed by the harness, which the module
// picks up by being inlined into it. Requires `lute` on PATH (mise, in dev and
// CI).
const HARNESS = readHarness("runner-result");
const STUBBED = stubbedModules(HARNESS);
const MODULE_SOURCE = readLuauTree("runner-result.luau", STUBBED);

describe("shared runner-result builder under lute", () => {
	it("should pass the runner-result harness assertions", () => {
		expect.assertions(1);

		const script = fillPlaceholders(HARNESS, { __MODULE__: MODULE_SOURCE });

		expect(spawnHarness("runner-result-", script)).toContain("ALL OK");
	});
});
