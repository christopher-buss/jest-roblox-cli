import { describe, it } from "vitest";

import {
	fillPlaceholders,
	readHarness,
	readLuauTree,
	spawnHarness,
	stubbedModules,
} from "#test/helpers/integration/lute-harness.ts";

// Drives the coordinator's slice planner and gather under lute.  Requires `lute`
// on PATH (mise, in dev and CI).
const HARNESS = readHarness("vm-parallel");
const STUBBED = stubbedModules(HARNESS);
const MODULE_SOURCE = readLuauTree("vm-parallel.luau", STUBBED);

describe("vm-parallel dispatch planning under lute", () => {
	it("should pass the vm-parallel harness assertions", ({ expect }) => {
		expect.assertions(1);

		const script = fillPlaceholders(HARNESS, { __MODULE__: MODULE_SOURCE });

		expect(spawnHarness("vm-parallel-", script)).toContain("ALL OK");
	});
});
