import { describe, expect, it } from "vitest";

import {
	fillPlaceholders,
	readHarness,
	readLuauModule,
	spawnHarness,
} from "#test/luau/lute-harness.ts";
import { LUTE_HARNESS_TIMEOUT } from "#test/luau/lute-timeout.ts";

const MODULE_SOURCE = readLuauModule("runtime-stub-hooks.luau");
const HARNESS = readHarness("runtime-stub-hooks");

describe("runtime jest.config stubs under lute", { timeout: LUTE_HARNESS_TIMEOUT }, () => {
	it("should pass the runtime-stub-hooks harness assertions", () => {
		expect.assertions(1);

		const script = fillPlaceholders(HARNESS, { __MODULE__: MODULE_SOURCE });

		expect(spawnHarness("runtime-stub-hooks-", script)).toContain("ALL OK");
	});
});
