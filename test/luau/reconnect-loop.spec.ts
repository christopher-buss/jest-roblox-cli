import { describe, expect, it } from "vitest";

import {
	fillPlaceholders,
	readHarness,
	readLuauModule,
	spawnHarness,
} from "#test/luau/lute-harness.ts";

const MODULE_SOURCE = readLuauModule("../plugin/src/reconnect-loop.luau");
const HARNESS = readHarness("reconnect-loop");

describe("edit-mode plugin reconnect loop under lute", () => {
	it("should pass the reconnect-loop harness assertions", () => {
		expect.assertions(1);

		const script = fillPlaceholders(HARNESS, { __MODULE__: MODULE_SOURCE });

		expect(spawnHarness("reconnect-loop-", script)).toContain("ALL OK");
	});
});
