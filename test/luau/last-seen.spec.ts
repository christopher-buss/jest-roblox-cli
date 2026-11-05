import { describe, expect, it } from "vitest";

import {
	fillPlaceholders,
	inlineRequires,
	readHarness,
	readLuauModule,
	spawnHarness,
} from "#test/luau/lute-harness.ts";
import { LUTE_HARNESS_TIMEOUT } from "#test/luau/lute-timeout.ts";

// Drives the last-seen record under lute. Its circus-hook and data-model-path
// dependencies are inlined in place of the relative requires, then the whole
// module is inlined into the harness the same way the runner welds it. Requires
// `lute` on PATH (mise, in dev and CI).
const MODULE_SOURCE = inlineRequires(readLuauModule("last-seen.luau"), [
	"circus-hook",
	"data-model-path",
]);
const HARNESS = readHarness("last-seen");

describe("last-seen record under lute", { timeout: LUTE_HARNESS_TIMEOUT }, () => {
	it("should pass the last-seen harness assertions", () => {
		expect.assertions(1);

		const script = fillPlaceholders(HARNESS, { __MODULE__: MODULE_SOURCE });

		expect(spawnHarness("last-seen-", script)).toContain("ALL OK");
	});
});
