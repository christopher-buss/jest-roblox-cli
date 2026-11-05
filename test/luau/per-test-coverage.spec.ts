import { describe, expect, it } from "vitest";

import {
	fillPlaceholders,
	inlineRequires,
	readHarness,
	readLuauModule,
	spawnHarness,
} from "#test/luau/lute-harness.ts";
import { LUTE_HARNESS_TIMEOUT } from "#test/luau/lute-timeout.ts";

// Drives the per-test coverage hook under lute. Its coverage-attribution
// dependency is inlined in place of the relative require, then the whole module
// is inlined into the harness the same way the runner welds it. Requires `lute`
// on PATH (mise, in dev and CI).
const MODULE_SOURCE = inlineRequires(readLuauModule("per-test-coverage.luau"), [
	"coverage-attribution",
	"circus-hook",
	"data-model-path",
]);
const HARNESS = readHarness("per-test-coverage");

describe("per-test coverage hook under lute", { timeout: LUTE_HARNESS_TIMEOUT }, () => {
	it("should pass the per-test coverage harness assertions", () => {
		expect.assertions(1);

		const script = fillPlaceholders(HARNESS, { __MODULE__: MODULE_SOURCE });

		expect(spawnHarness("per-test-cov-", script)).toContain("ALL OK");
	});
});
