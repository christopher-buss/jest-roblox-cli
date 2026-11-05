import { describe, expect, it } from "vitest";

import { readHarness, readLuauModule, spawnHarness } from "#test/luau/lute-harness.ts";
import { LUTE_HARNESS_TIMEOUT } from "#test/luau/lute-timeout.ts";

// Drives the code-bundle rebuild under lute against a fake DataModel the
// harness supplies. The module reads its bundle out of the task's varargs, so
// it is inlined as a vararg function rather than called for a return value.
// Requires `lute` on PATH (mise, in dev and CI).
const MODULE_SOURCE = readLuauModule("code-bundle-rebuild.luau");
const HARNESS = readHarness("code-bundle-rebuild");

describe("code bundle rebuild under lute", { timeout: LUTE_HARNESS_TIMEOUT }, () => {
	it("should pass the code-bundle-rebuild harness assertions", () => {
		expect.assertions(1);

		const script = HARNESS.replace("__MODULE__", () => `function(...)\n${MODULE_SOURCE}\nend`);

		expect(spawnHarness("code-bundle-rebuild-", script)).toContain("ALL OK");
	});
});
