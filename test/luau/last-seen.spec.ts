import { describe, expect, it } from "vitest";

import {
	fillPlaceholders,
	readHarness,
	readLuauTree,
	spawnHarness,
	stubbedModules,
} from "#test/luau/lute-harness.ts";

// Drives the last-seen record under lute. Its circus-hook and data-model-path
// dependencies are inlined in place of the relative requires, then the whole
// module is inlined into the harness the same way the runner welds it. Requires
// `lute` on PATH (mise, in dev and CI).
const HARNESS = readHarness("last-seen");
const STUBBED = stubbedModules(HARNESS);
const MODULE_SOURCE = readLuauTree("last-seen.luau", STUBBED);

describe("last-seen record under lute", () => {
	it("should pass the last-seen harness assertions", () => {
		expect.assertions(1);

		const script = fillPlaceholders(HARNESS, { __MODULE__: MODULE_SOURCE });

		expect(spawnHarness("last-seen-", script)).toContain("ALL OK");
	});
});
