import { describe, it } from "vitest";

import {
	fillPlaceholders,
	readHarness,
	readLuauModule,
	spawnHarness,
} from "#test/luau/lute-harness.ts";

// Inlines the attribution module into the harness as the runner welds it
// and runs it under lute (on PATH via mise); a failed assertion exits
// non-zero. Read from disk so the spec needs no `*.luau` ambient
// declaration.
const MODULE_SOURCE = readLuauModule("coverage-attribution.luau");
const HARNESS = readHarness("coverage-attribution");

describe("coverage attribution under lute", () => {
	it("should pass the attribution harness assertions", ({ expect }) => {
		expect.assertions(1);

		const script = fillPlaceholders(HARNESS, { __MODULE__: MODULE_SOURCE });

		expect(spawnHarness("cov-attr-", script)).toContain("ALL OK");
	});
});
