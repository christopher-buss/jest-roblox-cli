import { describe, expect, it } from "vitest";

import {
	fillPlaceholders,
	readHarness,
	readLuauModule,
	spawnHarness,
} from "#test/luau/lute-harness.ts";
import { LUTE_HARNESS_TIMEOUT } from "#test/luau/lute-timeout.ts";

const HOOK_SOURCE = readLuauModule("circus-hook.luau");
const MODULE_SOURCE = readLuauModule("cooperative-scheduler.luau");
const HARNESS = readHarness("cooperative-scheduler");

describe("cooperative scheduling under lute", { timeout: LUTE_HARNESS_TIMEOUT }, () => {
	it("should yield between completed tests while preserving hooks and run ownership", () => {
		expect.assertions(1);

		const source = fillPlaceholders(HARNESS, {
			__HOOK__: HOOK_SOURCE,
			__MODULE__: MODULE_SOURCE,
		});

		expect(spawnHarness("cooperative-scheduler-", source)).toContain("ALL OK");
	});
});
