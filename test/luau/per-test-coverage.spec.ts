import { describe, expect, it } from "vitest";

import {
	fillPlaceholders,
	readHarness,
	readLuauTree,
	spawnHarness,
	stubbedModules,
} from "#test/luau/lute-harness.ts";

// Drives the per-test coverage hook under lute. Its coverage-attribution
// dependency is inlined in place of the relative require, then the whole module
// is inlined into the harness the same way the runner welds it. Requires `lute`
// on PATH (mise, in dev and CI).
const HARNESS = readHarness("per-test-coverage");
const STUBBED = stubbedModules(HARNESS);
const MODULE_SOURCE = readLuauTree("per-test-coverage.luau", STUBBED);

describe("per-test coverage hook under lute", () => {
	it("should pass the per-test coverage harness assertions", () => {
		expect.assertions(1);

		const script = fillPlaceholders(HARNESS, { __MODULE__: MODULE_SOURCE });

		expect(spawnHarness("per-test-cov-", script)).toContain("ALL OK");
	});
});
