import { describe, expect, it } from "vitest";

import {
	fillPlaceholders,
	readHarness,
	readLuauModule,
	spawnHarness,
} from "#test/luau/lute-harness.ts";
import { LUTE_HARNESS_TIMEOUT } from "#test/luau/lute-timeout.ts";

// Drives the attribution module under the real lute binary, inlining it into the
// harness the same way the runner welds it. The harness exercises the pure
// snapshot/diff logic against a hand-built coverage hit table and calls error()
// on any failed assertion, so a non-zero lute exit fails this test. Requires
// `lute` on PATH (mise, in dev and CI). The source is read from disk (rather than
// imported) so the spec needs no `*.luau` ambient declaration.
const MODULE_SOURCE = readLuauModule("coverage-attribution.luau");
const HARNESS = readHarness("coverage-attribution");

describe("coverage attribution under lute", { timeout: LUTE_HARNESS_TIMEOUT }, () => {
	it("should pass the attribution harness assertions", () => {
		expect.assertions(1);

		const script = fillPlaceholders(HARNESS, { __MODULE__: MODULE_SOURCE });

		expect(spawnHarness("cov-attr-", script)).toContain("ALL OK");
	});
});
