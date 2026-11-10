import { describe, expect, it } from "vitest";

import {
	inlineModule,
	readHarness,
	readLuauModule,
	spawnHarness,
} from "#test/luau/lute-harness.ts";

const MODULE_SOURCE = readLuauModule("circus-state-release.luau");
const HARNESS = readHarness("circus-state-release");

describe("circus state release under lute", () => {
	it("should pass the circus-state-release harness assertions", () => {
		expect.assertions(1);

		const script = HARNESS.replace("__MODULE__", () => {
			return inlineModule(`local _G = fakeGlobals\n${MODULE_SOURCE}`);
		});

		expect(spawnHarness("circus-state-release-", script)).toContain("ALL OK");
	});
});
